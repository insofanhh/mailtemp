// Holds the real queue lock for all fixtures. Only in-process fake dispatches;
// scheduled fixtures are dated 2099. Never invokes SMTP, OAuth or cron.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
import {DIRECT_QUEUE_LOCK,dispatchDirectRecipient,finishDirectBatches} from '../src/lib/direct-mail';
import {claimRecipient,recipientDispatchBlockReason} from '../src/lib/worker';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='CONFLICT-QA-'+randomUUID().slice(0,8),sale=randomUUID(),admin=randomUUID();
const token=randomBytes(32).toString('hex'),adminToken=randomBytes(32).toString('hex'),cookie='mailtemp_session='+token,adminCookie='mailtemp_session='+adminToken;
const accountIds:string[]=[],contactIds:string[]=[],campaignIds:string[]=[],templateIds:string[]=[],emailList:string[]=[];
let checks=0,sends=0;
const pass=(message:string)=>console.log('PASS '+(++checks)+' '+message);
async function request(path:string,body?:unknown,session=cookie,method=body===undefined?'GET':'POST'){
  return fetch(base+'/api/'+path,{method,headers:{Origin:base,Cookie:session,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function api(path:string,body?:unknown,session=cookie,method?:string){const response=await request(path,body,session,method),value=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(value));return value;}
async function contact(accountId?:string,email?:string){
  if(!accountId){accountId=randomUUID();accountIds.push(accountId);await run('INSERT INTO accounts(id,name,ownerId) VALUES (?,?,?)',[accountId,prefix+' Agency',sale]);}
  const id=randomUUID();email=email||prefix.toLowerCase()+contactIds.length+'@example.invalid';contactIds.push(id);emailList.push(email);
  await run("INSERT INTO contacts(id,accountId,email,name,source,country) VALUES (?,?,?,?,?,'VN')",[id,accountId,email,'Fixture','QA website']);return {id,accountId,email};
}
const input=(ids:string[])=>({name:prefix,subject:'QA {{company_name}}',body:'QA {{contact_name}}',contactIds:ids});
async function preview(ids:string[]){return api('direct-mail/preview',input(ids));}
async function start(ids:string[],risk=false){const draft=input(ids),p=await preview(ids);const result=await api('direct-mail',{input:draft,requestId:randomUUID(),previewToken:p.previewToken,acceptExclusions:true,acceptDuplicateRisk:risk});const [r]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[result.id]);return {id:result.id,recipientId:r.id};}
async function unknown(id:string){const batch=await start([id]);await dispatchDirectRecipient(batch.recipientId,async()=>{throw new Error('Fixture ambiguous provider outcome');});await finishDirectBatches();return batch;}
const reason='QA administrator accepts duplicate risk for exactly one replacement send.';
async function grant(batch:{id:string;recipientId:string}){return api('direct-mail/'+batch.id+'/authorize-retry',{recipientId:batch.recipientId,reason,acceptDuplicateRisk:true},adminCookie);}
const lock=await pool().getConnection();const [locks]=await lock.query('SELECT GET_LOCK(?,10) acquired',[DIRECT_QUEUE_LOCK]);assert.equal((locks as {acquired:number}[])[0].acquired,1);
try{
  for(const [id,role] of [[sale,'sale'],[admin,'admin']])await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,'fixture-only',?)",[id,prefix,prefix.toLowerCase()+id.slice(0,6)+'@example.invalid',role]);
  for(const [value,id] of [[token,sale],[adminToken,admin]])await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))',[hash(value),id]);
  const first=await contact(),sibling=await contact(first.accountId),old=await unknown(first.id);
  let p=await preview([first.id,sibling.id]);assert.equal(p.eligible,1);assert.equal(p.blocked,1);const blocked=p.recipients.find((r:{id:string})=>r.id===first.id);assert.equal(blocked.conflicts[0].batchId,old.id);assert.equal(blocked.conflicts[0].status,'unknown');assert.equal(blocked.conflicts[0].email,first.email);assert.equal(blocked.conflicts[0].canManage,true);
  assert.equal(p.recipients.find((r:{id:string})=>r.id===sibling.id).reason,null);
  const siblingBatch=await start([sibling.id]);assert.equal((await preview([sibling.id])).eligible,0);await api('direct-mail/'+siblingBatch.id,{action:'cancel'},cookie,'PATCH');assert.equal((await preview([sibling.id])).eligible,1);
  pass('Unknown locks only its exact email; other contacts in the same agency work; cancel immediately releases pending email');

  await run('UPDATE direct_mail_batches SET ownerId=? WHERE id=?',[admin,old.id]);p=await preview([first.id]);assert.equal(p.recipients[0].conflicts[0].canManage,false);assert.equal(p.recipients[0].conflicts[0].batchId,null);assert.equal(p.recipients[0].conflicts[0].batchName,'Lượt gửi của sale khác');assert.equal((await request('direct-mail/'+old.id)).status,403);await run('UPDATE direct_mail_batches SET ownerId=? WHERE id=?',[sale,old.id]);
  assert.equal((await request('direct-mail/'+old.id+'/authorize-retry',{recipientId:old.recipientId,reason,acceptDuplicateRisk:true})).status,403);
  assert.equal((await request('direct-mail/'+old.id+'/authorize-retry',{recipientId:old.recipientId,reason,acceptDuplicateRisk:false},adminCookie)).status,400);
  assert.equal((await request('direct-mail/'+old.id+'/authorize-retry',{recipientId:old.recipientId,reason:'short',acceptDuplicateRisk:true},adminCookie)).status,400);
  pass('Other sales see no private batch identity; only admin can authorize, with explicit duplicate-risk acknowledgement and a meaningful reason');

  await grant(old);await grant(old);const [original]=await rows('SELECT * FROM direct_mail_recipients WHERE id=?',[old.recipientId]);assert.equal(original.status,'unknown');assert.equal(original.retryAuthorizedBy,admin);assert.equal(original.retryConsumedBy,null);assert.equal((await rows("SELECT COUNT(*) n FROM audit_logs WHERE entityId=? AND action='direct_mail_retry_authorized'",[old.recipientId]))[0].n,1);
  assert.equal((await api('direct-mail/'+old.id)).batch.status,'review_released');p=await preview([first.id]);assert.equal(p.eligible,1);assert.equal(p.retryCount,1);assert.deepEqual(p.recipients[0].retryAuthorizationIds,[old.recipientId]);
  const payload={input:input([first.id]),requestId:randomUUID(),previewToken:p.previewToken,acceptExclusions:true};assert.equal((await request('direct-mail',payload)).status,409);
  pass('Grant preserves original unknown history, is idempotent, sends nothing, and requires a second explicit risk confirmation at send');

  const one={...payload,acceptDuplicateRisk:true},two={...one,requestId:randomUUID()};const responses=await Promise.all([request('direct-mail',one),request('direct-mail',two)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);const values=await Promise.all(responses.map(r=>r.json()));const winner=values[responses.findIndex(r=>r.status===200)];const winnerPayload=responses[0].status===200?one:two;const replay=await api('direct-mail',winnerPayload);assert.equal(replay.id,winner.id);assert.equal(replay.alreadyStarted,true);
  const [replacement]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[winner.id]);assert.equal((await rows('SELECT retryConsumedBy FROM direct_mail_recipients WHERE id=?',[old.recipientId]))[0].retryConsumedBy,replacement.id);
  assert.equal((await request('direct-mail/'+old.id+'/authorize-retry',{recipientId:old.recipientId,reason,acceptDuplicateRisk:true},adminCookie)).status,409);
  await Promise.all([dispatchDirectRecipient(replacement.id,async envelope=>{assert.equal(envelope.email,first.email);sends++;}),dispatchDirectRecipient(replacement.id,async()=>{sends++;})]);assert.equal(sends,1);await finishDirectBatches();assert.equal((await api('direct-mail/'+winner.id)).batch.status,'completed');assert.equal((await rows('SELECT status FROM direct_mail_recipients WHERE id=?',[old.recipientId]))[0].status,'unknown');assert.match((await preview([first.id])).recipients[0].reason,/24 giờ/);
  pass('Concurrent starts consume the grant once; repeat request recovers the same batch; concurrent dispatch sends once and preserves cooldown');

  const repeatContact=await contact(),repeatOld=await unknown(repeatContact.id);await grant(repeatOld);const repeatNew=await start([repeatContact.id],true);await dispatchDirectRecipient(repeatNew.recipientId,async()=>{throw new Error('Unknown again');});await finishDirectBatches();p=await preview([repeatContact.id]);assert.equal(p.eligible,0);assert.equal(p.recipients[0].conflicts[0].batchId,repeatNew.id);assert.equal(p.retryCount,0);
  pass('A replacement with unknown outcome blocks again; an earlier consumed grant cannot authorize another attempt');

  const moved=await contact(),movedOld=await unknown(moved.id);const changedEmail=prefix.toLowerCase()+'-changed@example.invalid';emailList.push(changedEmail);await run('UPDATE contacts SET email=? WHERE id=?',[changedEmail,moved.id]);assert.equal((await preview([moved.id])).eligible,1);const restored=await contact(undefined,moved.email);p=await preview([restored.id]);assert.equal(p.eligible,0);assert.equal(p.recipients[0].conflicts[0].batchId,movedOld.id);
  pass('Historical snapshots keep locking their actual recipient email even after contact email or agency changes');

  await run('UPDATE contacts SET lastContactedAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 DAY) WHERE id=?',[first.id]);
  const template=await api('templates',{name:prefix,subject:'QA {{company_name}}',body:'QA {{contact_name}}'});templateIds.push(template.id);
  const campaign=await api('campaigns',{name:prefix,templateId:template.id,productId:null,recipientPolicy:'include_unreviewed',contactIds:[sibling.id],followupBody:'',followupDays:4});campaignIds.push(campaign.id);let campaignPreview=await api('campaigns/'+campaign.id);assert.equal(campaignPreview.eligible,1);await api('campaigns/'+campaign.id,{action:'approve',acceptExclusions:true,previewToken:campaignPreview.previewToken},cookie,'PATCH');
  assert.equal((await preview([sibling.id])).eligible,0);assert.equal((await preview([first.id])).eligible,1);const differentEmail=await start([first.id]);
  await run("UPDATE campaigns SET status='scheduled',scheduledAt='2099-01-01' WHERE id=?",[campaign.id]);await run("UPDATE campaign_recipients SET dueAt='2099-01-01' WHERE campaignId=?",[campaign.id]);const [scheduled]=await rows('SELECT id FROM campaign_recipients WHERE campaignId=?',[campaign.id]);assert.ok(await claimRecipient(scheduled.id));assert.equal(await recipientDispatchBlockReason(scheduled.id,sale),null);
  await api('direct-mail/'+differentEmail.id,{action:'cancel'},cookie,'PATCH');await run("UPDATE campaign_recipients SET status='skipped' WHERE id=?",[scheduled.id]);
  const pendingGrant=await contact(),pendingOld=await unknown(pendingGrant.id);await grant(pendingOld);const guarded=await api('campaigns',{name:prefix+' guard',templateId:template.id,productId:null,recipientPolicy:'include_unreviewed',contactIds:[pendingGrant.id],followupBody:'',followupDays:4});campaignIds.push(guarded.id);campaignPreview=await api('campaigns/'+guarded.id);assert.equal(campaignPreview.eligible,0);
  pass('Direct and scheduled paths agree on exact email conflicts; scheduled worker accepts other email at same agency; direct retry grant cannot leak into a scheduled send');
  console.log(`Completed ${checks} conflict/retry groups. Real queue remained locked; no real email sent.`);
}finally{
  for(const id of campaignIds){await run('DELETE FROM campaign_recipients WHERE campaignId=?',[id]);await run('DELETE FROM campaigns WHERE id=?',[id]);}
  for(const id of templateIds)await run('DELETE FROM templates WHERE id=?',[id]);
  const batches=await rows('SELECT id FROM direct_mail_batches WHERE ownerId IN (?,?)',[sale,admin]);for(const batch of batches){await run('DELETE FROM direct_mail_recipients WHERE batchId=?',[batch.id]);await run('DELETE FROM direct_mail_batches WHERE id=?',[batch.id]);}
  for(const id of contactIds)await run('DELETE FROM contacts WHERE id=?',[id]);for(const id of accountIds)await run('DELETE FROM accounts WHERE id=?',[id]);
  for(const email of emailList)await run('DELETE FROM suppressions WHERE email=?',[email]);
  await run('DELETE FROM notifications WHERE userId IN (?,?)',[sale,admin]);await run('DELETE FROM audit_logs WHERE actorId IN (?,?)',[sale,admin]);await run('DELETE FROM users WHERE id IN (?,?)',[sale,admin]);
  await lock.query('SELECT RELEASE_LOCK(?)',[DIRECT_QUEUE_LOCK]);lock.release();await pool().end();
}

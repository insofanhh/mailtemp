// Local DB fixtures only. The real queue remains locked and all dispatched
// deliveries use an injected sender; campaign claims never contact SMTP.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {rows,run,pool} from '../src/lib/db';
import {previewDirectMail,startDirectMail,dispatchDirectRecipient,finishDirectBatches,DIRECT_QUEUE_LOCK} from '../src/lib/direct-mail';
import {directMailSchema} from '../src/lib/direct-mail-schema';
import {templateHistory,templateIdentity,backfillTemplateHistory} from '../src/lib/template-history';
import {claimRecipient,recipientDispatchBlockReason} from '../src/lib/worker';
import type {User} from '../src/lib/auth';

nextEnv.loadEnvConfig(process.cwd());
if(process.env.VERCEL_ENV||new URL(process.env.DATABASE_URL!).hostname.endsWith('.tidbcloud.com'))throw new Error('Use the local development database.');
const uid=randomUUID(),accountId=randomUUID(),contactId=randomUUID(),a=randomUUID(),b=randomUUID(),batches:string[]=[],campaigns:string[]=[];
const email=contactId+'@example.invalid',user={id:uid,name:'Template QA',email:uid+'@example.invalid',role:'sale'} as User;
const token=randomBytes(32).toString('hex'),base=process.env.APP_URL||'http://localhost:3000';
async function api(path:string,body?:unknown){const response=await fetch(base+'/api/'+path,{method:body?'PATCH':'GET',headers:{Origin:base,Cookie:'mailtemp_session='+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()};}
let sends=0,checks=0;
const fake=async()=>{sends++;},pass=(label:string)=>console.log(`PASS ${++checks} ${label}`);
const input=(templateId:string|null=a,allowTemplateResend=false)=>directMailSchema.parse({name:'Template QA',templateId,allowTemplateResend,subject:templateId===b?'Template B':'Template A',body:templateId===b?'Body B':'Body A',contactIds:[contactId]});
async function start(data=input()){
  const preview=await previewDirectMail(user,data);assert.equal(preview.eligible,1,preview.recipients[0]?.reason||'Eligible');
  const started=await startDirectMail(user,data,randomUUID(),preview.previewToken,true);batches.push(started.id);
  const [recipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[started.id]);return {id:started.id,recipientId:recipient.id};
}
async function campaign(templateId=a,resend=false,step=0){
  const id=randomUUID(),recipientId=randomUUID();campaigns.push(id);
  await run("INSERT INTO campaigns(id,name,ownerId,templateId,allowTemplateResend,recipientPolicy,status,subject,body,followupBody,templateVersion,approvedAt) VALUES (?,'Template QA',?,?,?,'include_unreviewed','scheduled',?,?,?,1,UTC_TIMESTAMP(3))",[id,uid,templateId,resend,templateId===b?'Template B':'Template A',templateId===b?'Body B':'Body A','Different follow-up']);
  await run('INSERT INTO campaign_recipients(id,campaignId,contactId,step) VALUES (?,?,?,?)',[recipientId,id,contactId,step]);return {id,recipientId};
}
const lock=await pool().getConnection();
try{
  const [held]=await lock.query('SELECT GET_LOCK(?,10) acquired',[DIRECT_QUEUE_LOCK]);assert.equal((held as {acquired:number}[])[0].acquired,1);
  await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,'Template QA',?,'fixture-only','sale')",[uid,user.email]);
  await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE))',[createHash('sha256').update(token).digest('hex'),uid]);
  await run("INSERT INTO accounts(id,name,ownerId) VALUES (?,'Template QA',?)",[accountId,uid]);
  await run("INSERT INTO contacts(id,accountId,email,source) VALUES (?,?,?,'QA website')",[contactId,accountId,email]);
  for(const [id,subject,body] of [[a,'Template A','Body A'],[b,'Template B','Body B']])await run("INSERT INTO templates(id,name,subject,body,category) VALUES (?,'Template QA',?,?,'QA')",[id,subject,body]);
  const first=await start();assert.equal(await dispatchDirectRecipient(first.recipientId,fake),true);await finishDirectBatches(first.id);assert.equal(sends,1);
  assert.equal((await previewDirectMail(user,input())).eligible,0);
  assert.equal((await previewDirectMail(user,input(b))).eligible,1);
  await run("UPDATE contacts SET lastContactedAt='2000-01-01' WHERE id=?",[contactId]);
  assert.equal((await previewDirectMail(user,input())).eligible,0);
  assert.equal((await previewDirectMail(user,{...input(),subject:'Edited',body:'Edited body'})).eligible,0);
  pass('Accepted template stays blocked after 24h and across edits; a different template can send immediately');
  const resend=await start(input(a,true));await dispatchDirectRecipient(resend.recipientId,fake);await finishDirectBatches(resend.id);
  assert.equal(sends,2);assert.equal(await dispatchDirectRecipient(resend.recipientId,fake),false);assert.equal(sends,2);
  assert.equal((await previewDirectMail(user,input())).eligible,0);
  pass('Resend mode applies only to its batch and repeated worker calls do not resend a recipient');
  const blocked=await campaign();await run("UPDATE campaigns SET status='draft' WHERE id=?",[blocked.id]);
  assert.equal((await api('campaigns/'+blocked.id)).value.eligible,0);
  assert.equal((await api('campaigns/'+blocked.id,{action:'template-resend',allowTemplateResend:true})).status,200);
  assert.equal((await api('campaigns/'+blocked.id)).value.eligible,1);
  assert.equal((await api('campaigns/'+blocked.id,{action:'template-resend',allowTemplateResend:false})).status,200);
  assert.equal((await api('campaigns/'+blocked.id)).value.eligible,0);
  await run("UPDATE campaigns SET status='scheduled',approvedAt=UTC_TIMESTAMP(3) WHERE id=?",[blocked.id]);
  pass('Campaign API previews duplicate exclusions and toggles resend mode while invalidating approval');
  assert.equal(await claimRecipient(blocked.recipientId),null);
  assert.match((await rows('SELECT error FROM campaign_recipients WHERE id=?',[blocked.recipientId]))[0].error,/đã nhận mẫu/);
  await run("UPDATE campaigns SET status='completed' WHERE id=?",[blocked.id]);
  const allowed=await campaign(a,true);const claim=await claimRecipient(allowed.recipientId);assert.ok(claim);
  assert.equal(await recipientDispatchBlockReason(allowed.recipientId,uid),null);
  await run("UPDATE campaigns SET status='paused' WHERE id=?",[allowed.id]);
  assert.equal((await api('campaigns/'+allowed.id,{action:'template-resend',allowTemplateResend:false})).status,409);
  await run("UPDATE campaign_recipients SET status='accepted',sentAt=UTC_TIMESTAMP(3) WHERE id=?",[allowed.recipientId]);await run("UPDATE campaigns SET status='completed' WHERE id=?",[allowed.id]);
  pass('Campaign worker shares direct-mail history and requires explicit resend mode');
  const other=await campaign(b);assert.ok(await claimRecipient(other.recipientId));
  await run("UPDATE campaign_recipients SET status='accepted',sentAt=UTC_TIMESTAMP(3) WHERE id=?",[other.recipientId]);await run("UPDATE campaigns SET status='completed' WHERE id=?",[other.id]);
  assert.equal((await previewDirectMail(user,input(b))).eligible,0);
  const identicalFollowup=await campaign(b,false,1);
  await run("UPDATE campaigns SET followupBody='Body B' WHERE id=?",[identicalFollowup.id]);
  assert.equal(await claimRecipient(identicalFollowup.recipientId),null);
  await run("UPDATE campaigns SET status='completed' WHERE id=?",[identicalFollowup.id]);
  const followup=await campaign(b,false,1);assert.ok(await claimRecipient(followup.recipientId));
  await run("UPDATE campaign_recipients SET status='skipped' WHERE id=?",[followup.recipientId]);await run("UPDATE campaigns SET status='completed' WHERE id=?",[followup.id]);
  pass('Campaign acceptance blocks direct resend of the same template; a distinct follow-up remains allowed');
  const raw=input(null);assert.equal((await previewDirectMail(user,raw)).eligible,0);
  assert.equal((await previewDirectMail(user,{...raw,body:'Brand new ad hoc body'})).eligible,1);
  pass('Ad hoc content uses subject/body history, including mail originally sent from a named template');
  // Simulate acceptance after preview/queue creation. The dispatcher must still
  // refuse the duplicate even when the UI previously found it eligible.
  const queued=await start({...input(b),subject:'New template C',body:'Body C',templateId:null});
  await run('UPDATE direct_mail_batches SET templateId=?,templateKey=?,contentKey=? WHERE id=?',[a,templateIdentity('Template A','Body A',a).templateKey,templateIdentity('Template A','Body A',a).contentKey,queued.id]);
  await run("UPDATE direct_mail_batches SET subject='Template A',body='Body A' WHERE id=?",[queued.id]);
  assert.equal(await dispatchDirectRecipient(queued.recipientId,fake),false);assert.equal(sends,2);
  const [skipped]=await rows('SELECT status,attempts FROM direct_mail_recipients WHERE id=?',[queued.recipientId]);assert.equal(skipped.status,'skipped');assert.equal(skipped.attempts,0);
  pass('Worker rechecks duplicate history immediately before claiming and never calls transport for duplicates');
  await run('UPDATE direct_mail_batches SET templateId=NULL,templateKey=NULL,contentKey=NULL WHERE id=?',[first.id]);
  await backfillTemplateHistory();await backfillTemplateHistory();
  const history=await templateHistory([email],templateIdentity('Template A','Body A',a));assert.equal(history.get(email),'accepted');
  pass('Legacy history backfill is repeatable and preserves prior accepted mail');
  console.log(`Completed ${checks} template-history check groups. Real emails sent: 0.`);
}finally{
  for(const id of batches){await run('DELETE FROM direct_mail_recipients WHERE batchId=?',[id]);await run('DELETE FROM direct_mail_batches WHERE id=?',[id]);}
  for(const id of campaigns){await run('DELETE FROM campaign_recipients WHERE campaignId=?',[id]);await run('DELETE FROM campaigns WHERE id=?',[id]);}
  await run('DELETE FROM contacts WHERE id=?',[contactId]);await run('DELETE FROM accounts WHERE id=?',[accountId]);
  for(const id of [a,b])await run('DELETE FROM templates WHERE id=?',[id]);
  await run('DELETE FROM audit_logs WHERE actorId=?',[uid]);await run('DELETE FROM notifications WHERE userId=?',[uid]);await run('DELETE FROM users WHERE id=?',[uid]);
  await lock.query('SELECT RELEASE_LOCK(?)',[DIRECT_QUEUE_LOCK]);lock.release();await pool().end();
}

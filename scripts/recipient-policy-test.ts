// Fixture-only checks: no cron, transport, or schedule API is called.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
import {claimRecipient,recipientDispatchBlockReason} from '../src/lib/worker';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='POLICY-QA-'+randomUUID().slice(0,8),userId=randomUUID(),otherUser=randomUUID();
const token=randomBytes(32).toString('hex'),cookie='mailtemp_session='+token;
const ids:Record<string,string[]>={accounts:[],contacts:[],templates:[],campaigns:[]};
let checks=0;
const pass=(label:string)=>console.log('PASS '+(++checks)+' '+label);
async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST'){
  return fetch(base+'/api/'+path,{method,headers:{Origin:base,Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function api(path:string,body?:unknown,method?:string){const r=await request(path,body,method),value=await r.json();assert.equal(r.status,200,path+': '+JSON.stringify(value));return value;}
async function create(resource:string,body:unknown){const {id}=await api(resource,body);ids[resource].push(id);return id as string;}
try{
  for(const uid of [userId,otherUser])await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,'fixture-only','sale')",[uid,prefix,prefix.toLowerCase()+uid.slice(0,8)+'@example.com']);
  await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),userId]);
  const contacts:string[]=[];
  for(let i=0;i<4;i++){
    const accountId=await create('accounts',{name:prefix+' Agency '+i});
    contacts.push(await create('contacts',{accountId,email:prefix.toLowerCase()+i+'@example.com',source:'QA website source',country:'VN'}));
  }
  await api('contacts/'+contacts[1],{consentStatus:'eligible',consentPurpose:'QA receive business quotations',consentEvidence:'QA explicitly registered to receive quotations'},'PATCH');
  await api('contacts/'+contacts[2],{consentStatus:'ineligible'},'PATCH');
  await api('suppressions',{email:prefix.toLowerCase()+'3@example.com',reason:'manual'});
  const templateId=await create('templates',{name:prefix+' Plain',subject:'Hợp tác',body:'Chào đại lý, xin gửi thông tin hợp tác.'});
  const body={name:prefix+' Campaign',templateId,contactIds:contacts};
  const campaignId=await create('campaigns',body),path='campaigns/'+campaignId;
  let preview=await api(path);assert.equal(preview.campaign.recipientPolicy,'eligible_only');assert.equal(preview.eligible,1);assert.equal(preview.blocked,3);
  assert.equal((await request(path,{action:'approve'},'PATCH')).status,409);
  pass('Default policy requires review; mixed list requires explicit exclusion confirmation');
  await api(path,{action:'recipient-policy',recipientPolicy:'include_unreviewed'},'PATCH');
  preview=await api(path);assert.equal(preview.eligible,2);assert.equal(preview.blocked,2);assert.ok(preview.recipients.find((r:{id:string})=>r.id===contacts[0]).preview);
  assert.equal((await rows('SELECT consentStatus,consentEvidence FROM contacts WHERE id=?',[contacts[0]]))[0].consentStatus,'unreviewed');
  assert.equal((await request(path,{action:'approve',acceptExclusions:true},'PATCH')).status,409);
  pass('Opt-in campaign filter includes unreviewed without changing contact consent; blocked contacts stay blocked');
  const competingId=await create('campaigns',{...body,name:prefix+' Excluded conflict',contactIds:[contacts[2]]});
  // Approved only, no dueAt: not a cron candidate. This conflict concerns an excluded account.
  await run("UPDATE campaigns SET status='approved',approvedAt=UTC_TIMESTAMP(3) WHERE id=?",[competingId]);
  preview=await api(path);assert.match(preview.recipients.find((r:{id:string})=>r.id===contacts[2]).reason,/chiến dịch khác/);
  const oldToken=preview.previewToken;
  await run('UPDATE contacts SET source=? WHERE id=?',['',contacts[0]]);
  assert.equal((await request(path,{action:'approve',acceptExclusions:true,previewToken:oldToken},'PATCH')).status,409);
  assert.equal((await rows('SELECT status FROM campaigns WHERE id=?',[campaignId]))[0].status,'draft');
  await run('UPDATE contacts SET source=? WHERE id=?',['QA website source',contacts[0]]);
  preview=await api(path);
  await api(path,{action:'approve',acceptExclusions:true,previewToken:preview.previewToken},'PATCH');
  const deliveries=await rows('SELECT * FROM campaign_recipients WHERE campaignId=?',[campaignId]);
  assert.equal(deliveries.filter(r=>r.status==='pending').length,2);assert.equal(deliveries.filter(r=>r.status==='skipped').length,2);
  for(const r of deliveries.filter(r=>r.status==='skipped'))assert.match(r.error,/Bộ lọc người nhận/);
  assert.ok(deliveries.every(r=>r.dueAt===null&&r.sentAt===null&&r.attempts===0));
  const [audit]=await rows("SELECT details FROM audit_logs WHERE entityId=? AND action='campaign_recipients_approved'",[campaignId]);assert.ok(audit);
  pass('Stale preview cannot approve; confirmed mixed list approves eligible rows despite conflicts on excluded accounts; records skipped reasons without scheduling');
  await api(path,{action:'recipient-policy',recipientPolicy:'eligible_only'},'PATCH');
  assert.equal((await rows('SELECT status FROM campaigns WHERE id=?',[campaignId]))[0].status,'draft');
  assert.equal((await rows("SELECT COUNT(*) n FROM campaign_recipients WHERE campaignId=? AND status='pending'",[campaignId]))[0].n,4);
  await api(path+'/details',{...body,recipientPolicy:'include_unreviewed'},'PATCH');assert.equal((await api(path)).eligible,2);
  assert.equal((await request(path,{action:'recipient-policy',recipientPolicy:'any'},'PATCH')).status,400);
  await run('UPDATE campaigns SET ownerId=? WHERE id=?',[otherUser,campaignId]);assert.equal((await request(path,{action:'recipient-policy',recipientPolicy:'eligible_only'},'PATCH')).status,403);await run('UPDATE campaigns SET ownerId=? WHERE id=?',[userId,campaignId]);
  pass('Changing policy invalidates approval, resets only filter exclusions, supports draft editing and enforces authorization');
  preview=await api(path);await api(path,{action:'approve',acceptExclusions:true,previewToken:preview.previewToken},'PATCH');
  // Due dates far in the future protect fixtures even if an external cron runs.
  await run("UPDATE campaigns SET status='scheduled',scheduledAt='2099-01-01' WHERE id=?",[campaignId]);
  await run("UPDATE campaign_recipients SET dueAt='2099-01-01' WHERE campaignId=?",[campaignId]);
  const [recipient]=await rows('SELECT id FROM campaign_recipients WHERE campaignId=? AND contactId=?',[campaignId,contacts[0]]);
  const claim=await claimRecipient(recipient.id);assert.ok(claim);assert.ok(claim.content.body.includes('đại lý'));
  const [stop]=await rows("SELECT value FROM settings WHERE settingKey='emergency_stop'");
  assert.equal(await recipientDispatchBlockReason(recipient.id,userId),stop?.value==='true'?'Trạng thái thay đổi trước dispatch':null);
  assert.equal((await request(path,{action:'recipient-policy',recipientPolicy:'eligible_only'},'PATCH')).status,409);
  await run("UPDATE campaigns SET status='paused' WHERE id=?",[campaignId]);
  assert.equal((await request(path,{action:'recipient-policy',recipientPolicy:'eligible_only'},'PATCH')).status,409);
  await run("UPDATE campaigns SET status='running' WHERE id=?",[campaignId]);
  await api('suppressions',{email:prefix.toLowerCase()+'0@example.com',reason:'manual'});
  assert.match((await recipientDispatchBlockReason(recipient.id,userId))!,/chặn/);
  pass('Actual worker claim accepts unreviewed under saved policy; pre-dispatch rejects newly suppressed contact; policy locked after attempt');
  // A pending eligible row that becomes ineligible is skipped during actual claim.
  await run("UPDATE contacts SET consentStatus='needs_evidence' WHERE id=?",[contacts[1]]);
  const [next]=await rows('SELECT id FROM campaign_recipients WHERE campaignId=? AND contactId=?',[campaignId,contacts[1]]);
  assert.equal(await claimRecipient(next.id),null);assert.equal((await rows('SELECT status FROM campaign_recipients WHERE id=?',[next.id]))[0].status,'skipped');
  assert.equal((await rows("SELECT COUNT(*) n FROM campaign_recipients WHERE campaignId=? AND (sentAt IS NOT NULL OR status='accepted')",[campaignId]))[0].n,0);
  pass('Worker rechecks review changes and skips invalid recipients; zero sent mail');
  console.log(`Completed ${checks} recipient policy checks. No email sent.`);
}finally{
  const drop=async(table:string,column:string,values:string[])=>{if(values.length)await run(`DELETE FROM ${table} WHERE ${column} IN (${values.map(()=>'?').join(',')})`,values);};
  await drop('campaign_recipients','campaignId',ids.campaigns);await drop('campaigns','id',ids.campaigns);await drop('consent_events','contactId',ids.contacts);
  await run('DELETE FROM suppressions WHERE email LIKE ?',[prefix.toLowerCase()+'%']);await drop('contacts','id',ids.contacts);await drop('accounts','id',ids.accounts);await drop('templates','id',ids.templates);
  await run('DELETE FROM notifications WHERE userId IN (?,?) OR body LIKE ?',[userId,otherUser,prefix+'%']);await run('DELETE FROM audit_logs WHERE actorId IN (?,?)',[userId,otherUser]);await run('DELETE FROM users WHERE id IN (?,?)',[userId,otherUser]);await pool().end();
}

// Real API/database tests, with the global queue lock held for the entire fixture lifetime.
// Only an injected in-process sender handles fixtures. No cron or real SMTP/OAuth send is called.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
import {DIRECT_QUEUE_LOCK,dispatchDirectRecipient,finishDirectBatches} from '../src/lib/direct-mail';
import {messageContent} from '../src/lib/mail';
import {SmtpDeliveryError} from '../src/lib/smtp';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='DIRECT-QA-'+randomUUID().slice(0,8),userId=randomUUID(),adminId=randomUUID();
const token=randomBytes(32).toString('hex'),adminToken=randomBytes(32).toString('hex'),cookie='mailtemp_session='+token;
const accounts:string[]=[],contacts:string[]=[],emails:string[]=[];
let checks=0,sends=0;
const pass=(label:string)=>console.log('PASS '+(++checks)+' '+label);
async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST',session=cookie){return fetch(base+'/api/'+path,{method,headers:{Origin:base,Cookie:session,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function api(path:string,body?:unknown,method?:string,session?:string){const r=await request(path,body,method,session),value=await r.json();assert.equal(r.status,200,path+': '+JSON.stringify(value));return value;}
async function contact(){const accountId=randomUUID(),contactId=randomUUID(),email=prefix.toLowerCase()+contacts.length+'@example.invalid';accounts.push(accountId);contacts.push(contactId);emails.push(email);await run('INSERT INTO accounts(id,name,ownerId) VALUES (?,?,?)',[accountId,prefix+' Agency '+contacts.length,userId]);await run("INSERT INTO contacts(id,accountId,email,name,source,country) VALUES (?,?,?,?,?,'VN')",[contactId,accountId,email,'An','QA website source']);return contactId;}
async function start(ids:string[]){const input={name:prefix,subject:'Báo giá {{company_name}}',body:'Chào {{contact_name}}, thông tin từ {{sender_name}}.',contactIds:ids};const preview=await api('direct-mail/preview',input);const payload={input,requestId:randomUUID(),previewToken:preview.previewToken,acceptExclusions:true};const result=await api('direct-mail',payload);return {input,preview,payload,...result};}
const lock=await pool().getConnection();
const [locks]=await lock.query('SELECT GET_LOCK(?,10) acquired',[DIRECT_QUEUE_LOCK]);assert.equal((locks as {acquired:number}[])[0].acquired,1,'Cannot safely hold queue lock for fake transport tests');
try{
  for(const [uid,role] of [[userId,'sale'],[adminId,'admin']])await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,'fixture-only',?)",[uid,prefix,prefix.toLowerCase()+uid.slice(0,6)+'@example.invalid',role]);
  for(const [t,u] of [[token,userId],[adminToken,adminId]])await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(t),u]);
  assert.equal((await fetch(base+'/api/direct-mail')).status,401);
  assert.equal((await fetch(base+'/api/direct-mail/preview',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  pass('Authentication and same-origin validation protect direct sending');
  const first=await contact(),blocked=await contact();await api('suppressions',{email:emails[1],reason:'manual'});
  const input={name:prefix,subject:'Chào {{company_name}}',body:'Chào {{contact_name}}, tôi là {{sender_name}}.',contactIds:[first,blocked]};
  const preview=await api('direct-mail/preview',input);assert.equal(preview.eligible,1);assert.equal(preview.blocked,1);assert.equal(preview.gate,null);assert.ok(preview.recipients[0].preview.subject.startsWith('[QC]'));
  const payload={input,requestId:randomUUID(),previewToken:preview.previewToken,acceptExclusions:true};
  assert.equal((await request('direct-mail',{...payload,acceptExclusions:false})).status,409);
  assert.equal((await request('direct-mail',{...payload,input:{...input,body:'Changed'}})).status,409);
  const started=await api('direct-mail',payload),duplicate=await api('direct-mail',payload);assert.equal(started.id,duplicate.id);assert.equal(duplicate.alreadyStarted,true);
  assert.equal((await rows('SELECT COUNT(*) n FROM direct_mail_batches WHERE ownerId=?',[userId]))[0].n,1);
  assert.equal((await request('direct-mail',{...payload,input:{...input,body:'changed'}})).status,409);
  assert.equal((await request('direct-mail/preview',{...input,ownerId:adminId})).status,403);
  pass('Preview, exclusion confirmation, stale data and idempotent retries work with no schedule or address requirement');
  const details=await api('direct-mail/'+started.id),recipient=details.recipients.find((r:{status:string})=>r.status==='pending');
  const fake=async(envelope:{email:string;subject:string;body:string;contactId:string})=>{sends++;assert.ok(envelope.email.endsWith('@example.invalid'));assert.ok(envelope.subject.startsWith('[QC]'));assert.ok(envelope.body.includes('An'));const content=await messageContent(envelope.contactId,envelope.body);assert.equal(content.text,envelope.body);assert.ok(!content.html.includes('<hr>'));assert.ok(!content.html.includes('/api/unsubscribe'));assert.ok(!content.html.includes('Từ chối nhận email'));assert.ok(content.headers['List-Unsubscribe'].includes('/api/unsubscribe'));};
  await Promise.all([dispatchDirectRecipient(recipient.id,fake),dispatchDirectRecipient(recipient.id,fake)]);assert.equal(sends,1);
  assert.equal((await rows('SELECT status,attempts FROM direct_mail_recipients WHERE id=?',[recipient.id]))[0].status,'accepted');
  assert.equal((await rows('SELECT status,attempts FROM direct_mail_recipients WHERE id=?',[recipient.id]))[0].attempts,1);
  await finishDirectBatches();assert.equal((await api('direct-mail/'+started.id)).batch.status,'completed');
  pass('Actual dispatcher renders personalized mail, preserves authored content without an automatic footer, sends once under concurrent calls and completes batch');
  const errorContact=await contact(),errorBatch=await start([errorContact]);
  const [errorRecipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[errorBatch.id]);
  await dispatchDirectRecipient(errorRecipient.id,async()=>{throw new SmtpDeliveryError({responseCode:535},'authentication');});
  assert.equal((await rows('SELECT status FROM direct_mail_recipients WHERE id=?',[errorRecipient.id]))[0].status,'failed');
  const timeoutContact=await contact(),timeoutBatch=await start([timeoutContact]),[timeoutRecipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[timeoutBatch.id]);
  await dispatchDirectRecipient(timeoutRecipient.id,async()=>{throw new SmtpDeliveryError({code:'ETIMEDOUT',command:'CONN'},'connecting');});
  const [timeoutResult]=await rows('SELECT status,error,attempts FROM direct_mail_recipients WHERE id=?',[timeoutRecipient.id]);
  assert.equal(timeoutResult.status,'failed');assert.equal(timeoutResult.attempts,1);assert.match(timeoutResult.error,/ETIMEDOUT/);assert.match(timeoutResult.error,/không cần đối soát/);
  assert.equal(await dispatchDirectRecipient(timeoutRecipient.id,async()=>{sends++;}),false);
  await finishDirectBatches();assert.equal((await api('direct-mail/'+timeoutBatch.id)).batch.status,'completed');
  const dataContact=await contact(),dataBatch=await start([dataContact]),[dataRecipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[dataBatch.id]);
  await dispatchDirectRecipient(dataRecipient.id,async()=>{throw new SmtpDeliveryError({code:'ETIMEDOUT',command:'CONN'},'data');});
  assert.equal((await rows('SELECT status FROM direct_mail_recipients WHERE id=?',[dataRecipient.id]))[0].status,'unknown');
  assert.equal(await dispatchDirectRecipient(dataRecipient.id,async()=>{sends++;}),false);
  const unknownContact=await contact(),unknownBatch=await start([unknownContact]),[unknownRecipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[unknownBatch.id]);
  await dispatchDirectRecipient(unknownRecipient.id,async()=>{throw new Error('fake network timeout');});await finishDirectBatches();
  assert.equal((await api('direct-mail/'+unknownBatch.id)).batch.status,'needs_review');
  assert.equal(await dispatchDirectRecipient(unknownRecipient.id,async()=>{sends++;}),false);assert.equal(sends,1);
  assert.equal((await request('direct-mail/'+unknownBatch.id+'/reconcile',{recipientId:unknownRecipient.id,result:'not_sent',evidence:'QA provider explicitly confirms no send'})).status,403);
  await api('direct-mail/'+unknownBatch.id+'/reconcile',{recipientId:unknownRecipient.id,result:'not_sent',evidence:'QA provider explicitly confirms no send'},'POST','mailtemp_session='+adminToken);
  assert.equal((await api('direct-mail/'+unknownBatch.id)).batch.status,'completed');
  pass('SMTP auth and pre-DATA timeout failures are distinct from post-DATA uncertainty; no automatic resend; admin-only reconciliation works');
  const pauseContact=await contact(),pauseBatch=await start([pauseContact]),[pauseRecipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[pauseBatch.id]);
  await api('direct-mail/'+pauseBatch.id,{action:'pause'},'PATCH');assert.equal(await dispatchDirectRecipient(pauseRecipient.id,fake),false);
  await api('direct-mail/'+pauseBatch.id,{action:'resume'},'PATCH');assert.equal((await api('direct-mail/'+pauseBatch.id)).batch.status,'queued');
  await api('direct-mail/'+pauseBatch.id,{action:'cancel'},'PATCH');assert.equal((await api('direct-mail/'+pauseBatch.id)).recipients[0].status,'skipped');assert.equal(await dispatchDirectRecipient(pauseRecipient.id,fake),false);
  const suppressContact=await contact(),suppressBatch=await start([suppressContact]);await api('suppressions',{email:emails[emails.length-1],reason:'manual'});
  assert.equal((await api('direct-mail/'+suppressBatch.id)).recipients[0].status,'skipped');
  pass('Pause/resume/cancel and newly recorded suppressions prevent pending mail from being sent');
  const changeContact=await contact(),changeBatch=await start([changeContact]),[changeRecipient]=await rows('SELECT id FROM direct_mail_recipients WHERE batchId=?',[changeBatch.id]);
  await run("UPDATE contacts SET email=? WHERE id=?",[prefix.toLowerCase()+'-changed@example.invalid',changeContact]);
  assert.equal(await dispatchDirectRecipient(changeRecipient.id,fake),false);assert.match((await rows('SELECT error FROM direct_mail_recipients WHERE id=?',[changeRecipient.id]))[0].error,/thay đổi/);
  const ownedContact=await contact(),ownedBatch=await start([ownedContact]);
  await run('UPDATE direct_mail_batches SET ownerId=? WHERE id=?',[adminId,ownedBatch.id]);assert.equal((await request('direct-mail/'+ownedBatch.id)).status,403);await run('UPDATE direct_mail_batches SET ownerId=? WHERE id=?',[userId,ownedBatch.id]);
  assert.equal((await api('direct-mail')).some((r:{id:string})=>r.id===ownedBatch.id),true);
  assert.equal(sends,1);
  pass('Dispatcher rechecks changed email identity; details and history enforce ownership; no real email sent');
  console.log(`Completed ${checks} direct mail check groups. All deliveries used an injected fake sender; queue remained locked.`);
}finally{
  const batches=await rows('SELECT id FROM direct_mail_batches WHERE ownerId IN (?,?)',[userId,adminId]);
  for(const batch of batches){await run('DELETE FROM direct_mail_recipients WHERE batchId=?',[batch.id]);await run('DELETE FROM direct_mail_batches WHERE id=?',[batch.id]);}
  for(const id of contacts)await run('DELETE FROM contacts WHERE id=?',[id]);for(const id of accounts)await run('DELETE FROM accounts WHERE id=?',[id]);
  for(const email of emails)await run('DELETE FROM suppressions WHERE email=?',[email]);
  await run('DELETE FROM notifications WHERE userId IN (?,?)',[userId,adminId]);await run('DELETE FROM audit_logs WHERE actorId IN (?,?)',[userId,adminId]);await run('DELETE FROM users WHERE id IN (?,?)',[userId,adminId]);
  await lock.query('SELECT RELEASE_LOCK(?)',[DIRECT_QUEUE_LOCK]);lock.release();await pool().end();
}

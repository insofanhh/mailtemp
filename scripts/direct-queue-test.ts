// Database integration tests. Every delivery uses an injected sender and only
// fixture batch IDs are processed. Never invoke a production worker from here.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rows,run,pool} from '../src/lib/db';
import {previewDirectMail,startDirectMail,runDirectQueue,controlDirectMail,DIRECT_QUEUE_LOCK,type DirectSender} from '../src/lib/direct-mail';
import {directMailSchema} from '../src/lib/direct-mail-schema';
import {createMailJobConsumer,type MailJob} from '../src/lib/mail-jobs';
import type {User} from '../src/lib/auth';

nextEnv.loadEnvConfig(process.cwd());
if(process.env.VERCEL_ENV)throw new Error('Run database fixtures outside Vercel.');
const ownerId=randomUUID(),accountId=randomUUID(),contactIds:string[]=[],batches:string[]=[];
const user={id:ownerId,name:'Queue QA',role:'sale',email:ownerId+'@example.invalid'} as User;
const keys=['last_direct_worker_at','direct_worker_status'];
const previous=await rows('SELECT settingKey,value FROM settings WHERE settingKey IN (?,?)',keys);
let sends=0,checks=0;
const sender:DirectSender=async envelope=>{assert.ok(envelope.email.endsWith('@example.invalid'));sends++;};
const pass=(message:string)=>console.log(`PASS ${++checks} ${message}`);
async function batch(count=1){
  const ids=[];
  for(let i=0;i<count;i++){
    const id=randomUUID();contactIds.push(id);ids.push(id);
    await run("INSERT INTO contacts(id,accountId,email,source) VALUES (?,?,?,'QA website')",[id,accountId,id+'@example.invalid']);
  }
  const input=directMailSchema.parse({name:'Queue QA',subject:'Hello',body:'Hello agency',contactIds:ids});
  const preview=await previewDirectMail(user,input);assert.equal(preview.gate,null);
  const started=await startDirectMail(user,input,randomUUID(),preview.previewToken,true);batches.push(started.id);return started.id;
}
try{
  await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,'fixture-only','sale')",[ownerId,user.name,user.email]);
  await run('INSERT INTO accounts(id,name,ownerId) VALUES (?,?,?)',[accountId,'Queue QA',ownerId]);
  const id=await batch(2),lock=await pool().getConnection();
  try{
    await lock.query('SELECT GET_LOCK(?,5)',[DIRECT_QUEUE_LOCK]);
    assert.equal((await runDirectQueue({batchId:id,send:sender})).busy,true);assert.equal(sends,0);
  }finally{await lock.query('SELECT RELEASE_LOCK(?)',[DIRECT_QUEUE_LOCK]);lock.release();}
  const result=await Promise.all([runDirectQueue({batchId:id,send:sender}),runDirectQueue({batchId:id,send:sender})]);
  assert.equal(result.filter(r=>r.busy).length,1);assert.equal(sends,1);
  assert.equal((await rows("SELECT COUNT(*) n FROM direct_mail_recipients WHERE batchId=? AND status='pending'",[id]))[0].n,1);
  pass('Atomic worker lock prevents concurrent dispatch; one recipient per invocation');
  const pending:MailJob[]=[];
  const consume=createMailJobConsumer({direct:batchId=>runDirectQueue({batchId,send:sender}),scheduled:async()=>{throw new Error('unexpected');},pending:async batchId=>!!(await rows("SELECT id FROM direct_mail_recipients WHERE batchId=? AND status='pending'",[batchId])).length,publish:async job=>{pending.push(job);}});
  await consume({kind:'direct',batchId:id});await consume({kind:'direct',batchId:id});
  assert.equal(sends,2);assert.equal(pending.length,0);
  assert.equal((await rows('SELECT status FROM direct_mail_batches WHERE id=?',[id]))[0].status,'completed');
  assert.ok((await rows('SELECT attempts FROM direct_mail_recipients WHERE batchId=?',[id])).every(r=>r.attempts===1));
  pass('Repeated queue delivery does not resend accepted recipients');
  const interrupted=await batch();
  await run("UPDATE direct_mail_recipients SET status='sending',attempts=1,claimedAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 6 MINUTE) WHERE batchId=?",[interrupted]);
  await consume({kind:'direct',batchId:interrupted});
  assert.equal((await rows('SELECT status FROM direct_mail_recipients WHERE batchId=?',[interrupted]))[0].status,'unknown');
  assert.equal((await rows('SELECT status FROM direct_mail_batches WHERE id=?',[interrupted]))[0].status,'needs_review');assert.equal(sends,2);
  pass('Interrupted SMTP claims require reconciliation and are never automatically retried');
  const active=await batch();
  await run("UPDATE direct_mail_recipients SET status='sending',attempts=1,claimedAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 3 MINUTE) WHERE batchId=?",[active]);
  await consume({kind:'direct',batchId:active});
  assert.equal((await rows('SELECT status FROM direct_mail_recipients WHERE batchId=?',[active]))[0].status,'sending');assert.equal(sends,2);
  pass('Recovery does not expire an active claim inside its five-minute safety window');
  const paused=await batch();await controlDirectMail(user,paused,'pause');await consume({kind:'direct',batchId:paused});assert.equal(sends,2);
  await controlDirectMail(user,paused,'resume');await consume({kind:'direct',batchId:paused});assert.equal(sends,3);
  const cancelled=await batch();await controlDirectMail(user,cancelled,'cancel');await consume({kind:'direct',batchId:cancelled});assert.equal(sends,3);
  pass('Pause, resume and cancel remain effective with queue redelivery');
  console.log(`Completed ${checks} database worker checks; all sends used the injected fixture sender.`);
}finally{
  for(const id of batches){await run('DELETE FROM direct_mail_recipients WHERE batchId=?',[id]);await run('DELETE FROM direct_mail_batches WHERE id=?',[id]);}
  for(const id of contactIds)await run('DELETE FROM contacts WHERE id=?',[id]);
  await run('DELETE FROM accounts WHERE id=?',[accountId]);await run('DELETE FROM notifications WHERE userId=?',[ownerId]);await run('DELETE FROM audit_logs WHERE actorId=?',[ownerId]);await run('DELETE FROM users WHERE id=?',[ownerId]);
  for(const key of keys){const old=previous.find(r=>r.settingKey===key);if(old)await run('UPDATE settings SET value=? WHERE settingKey=?',[old.value,key]);else await run('DELETE FROM settings WHERE settingKey=?',[key]);}
  await pool().end();
}

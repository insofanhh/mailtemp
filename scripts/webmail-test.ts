// Database integration with an injected IMAP session. No real mailbox or SMTP is contacted.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import type {ImapFlow} from 'imapflow';
import {connectWebmail,syncWebmail} from '../src/lib/webmail';
import {withWebmail} from '../src/lib/webmail-client';
import {pool,rows,run} from '../src/lib/db';
import {decrypt} from '../src/lib/credentials';
import {workspace} from '../src/lib/workspace';
import {hash,type User} from '../src/lib/session';

nextEnv.loadEnvConfig(process.cwd());
const prefix='WEBMAIL-QA-'+randomUUID().slice(0,8),userId=randomUUID(),otherId=randomUUID(),accountId=randomUUID(),otherAccount=randomUUID(),contactId=randomUUID(),templateId=randomUUID(),campaignId=randomUUID();
const user:User={id:userId,name:prefix,email:prefix.toLowerCase()+'@example.invalid',role:'sale'};
const input={email:user.email,host:'mail.example.com',port:993 as const,username:user.email,password:randomBytes(24).toString('hex')};
const partner=prefix.toLowerCase()+'-partner@example.invalid',otherPartner=prefix.toLowerCase()+'-other@example.invalid';
const token=randomBytes(32).toString('hex'),base=process.env.APP_URL||'http://localhost:3000';
let validity='1',ids=[1,2,3],failUid=0,opens=0,fetches=0,checks=0;
const message=(email:string,id:string,auto=false)=>Buffer.from(`From: ${email}\r\nMessage-ID: <${prefix}-${id}@example.invalid>\r\nSubject: Bao gia\r\n${auto?'Auto-Submitted: auto-replied\r\n':''}Content-Type: text/plain; charset=utf-8\r\n\r\nXin bao gia cho doan 20 khach.`);
const client={
  mailboxOpen:async(path:string,options:{readOnly:boolean})=>{assert.equal(path,'INBOX');assert.equal(options.readOnly,true);opens++;return {uidValidity:BigInt(validity)};},
  search:async(query:{uid:string;since:Date},options:{uid:boolean})=>{assert.equal(options.uid,true);assert.ok(query.since instanceof Date);return ids;},
  fetchOne:async(uid:string,query:{source?:unknown},options:{uid:boolean})=>{
    assert.equal(options.uid,true);fetches++;
    if(Number(uid)===failUid)throw new Error('fake transient disconnect '+input.password);
    const email=uid==='2'?otherPartner:uid==='3'?user.email:partner;
    return query.source?{source:message(email,uid==='99'?'1':uid,uid==='4')}:{envelope:{from:[{address:email}],subject:'Bao gia'},internalDate:new Date()};
  },
} as unknown as ImapFlow;
const fake:typeof withWebmail=async(config,_budget,work)=>{assert.equal(config.password,input.password);return work(client);};
const pass=(label:string)=>console.log(`PASS ${++checks} ${label}`);
const lock=await pool().getConnection();
const [locks]=await lock.query("SELECT GET_LOCK('mailtemp_cron',10) acquired");assert.equal((locks as {acquired:number}[])[0].acquired,1);
try{
  for(const id of [userId,otherId])await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,'fixture-only','sale')",[id,prefix,prefix+id.slice(0,6)+'@example.invalid']);
  await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))',[hash(token),userId]);
  await run('INSERT INTO accounts(id,name,ownerId) VALUES (?,?,?),(?,?,?)',[accountId,prefix,userId,otherAccount,prefix,otherId]);
  await run('INSERT INTO contacts(id,accountId,email,name,source,country) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?)',[contactId,accountId,partner,'Partner','Fixture','VN',randomUUID(),otherAccount,otherPartner,'Other','Fixture','VN']);
  await run('INSERT INTO templates(id,name,subject,body) VALUES (?,?,?,?)',[templateId,prefix,'Hello','Hello']);
  await run("INSERT INTO campaigns(id,name,ownerId,templateId,status) VALUES (?,?,?,?,'paused')",[campaignId,prefix,userId,templateId]);
  await run('INSERT INTO campaign_recipients(id,campaignId,contactId,dueAt) VALUES (?,?,?,UTC_TIMESTAMP(3))',[randomUUID(),campaignId,contactId]);
  await assert.rejects(connectWebmail(user,input,async()=>{throw {authenticationFailed:true,response:input.password};}),/đăng nhập/);
  assert.equal((await rows('SELECT id FROM mailboxes WHERE userId=?',[userId])).length,0);
  pass('Failed authentication never saves a mailbox or plaintext credentials');

  await connectWebmail(user,input,fake);
  const [stored]=await rows('SELECT w.* FROM webmail_connections w JOIN mailboxes b ON b.id=w.mailboxId WHERE b.userId=?',[userId]);
  assert.equal(decrypt(stored.passwordEncrypted),input.password);assert.notEqual(stored.passwordEncrypted,input.password);
  const state=await workspace(user);assert.ok(!JSON.stringify(state).includes(input.password));assert.ok(!JSON.stringify(state).includes(stored.passwordEncrypted));
  await assert.rejects(connectWebmail(user,input,fake),/ngắt kết nối/);
  pass('Read-only connection stores an encrypted password, hides it from state and refuses accidental replacement');

  assert.equal(await syncWebmail(userId,18000,fake),1);
  assert.equal((await rows('SELECT id FROM inbound_messages WHERE contactId=?',[contactId])).length,1);
  assert.equal((await rows('SELECT status FROM campaign_recipients WHERE campaignId=?',[campaignId]))[0].status,'skipped');
  assert.equal((await rows('SELECT id FROM tasks WHERE ownerId=?',[userId])).length,1);
  assert.equal((await rows('SELECT lastUid FROM webmail_connections WHERE mailboxId=?',[stored.mailboxId]))[0].lastUid,3);
  assert.equal(await syncWebmail(userId,18000,fake),0);
  pass('Replies import only owned contacts, skip self mail, stop follow-up, create a task and are idempotent');

  await run('INSERT INTO campaign_recipients(id,campaignId,contactId,step,dueAt) VALUES (?,?,?,1,UTC_TIMESTAMP(3))',[randomUUID(),campaignId,contactId]);
  ids=[4];assert.equal(await syncWebmail(userId,18000,fake),1);
  const [auto]=await rows('SELECT status,dueAt FROM campaign_recipients WHERE campaignId=? AND step=1',[campaignId]);
  assert.equal(auto.status,'pending');assert.ok(new Date(auto.dueAt+'Z').getTime()>Date.now()+2*86400000);
  assert.equal((await rows('SELECT id FROM inbound_messages WHERE contactId=?',[contactId])).length,1);
  pass('Automatic replies postpone follow-up without creating a false human reply');

  validity='2';ids=[99];
  assert.equal(await syncWebmail(userId,18000,fake),0);
  assert.equal((await rows('SELECT id FROM inbound_messages WHERE contactId=?',[contactId])).length,1);
  pass('UIDVALIDITY reset replays safely without duplicating a message with the same Message-ID');

  ids=[100];failUid=100;
  await assert.rejects(syncWebmail(userId,18000,fake),/Không kết nối hoặc đồng bộ/);
  const [failed]=await rows('SELECT b.lastError,w.lastUid FROM mailboxes b JOIN webmail_connections w ON w.mailboxId=b.id WHERE b.userId=?',[userId]);
  assert.equal(failed.lastUid,99);assert.ok(!failed.lastError.includes(input.password));
  failUid=0;assert.equal(await syncWebmail(userId,18000,fake),1);
  assert.equal((await rows('SELECT lastError FROM mailboxes WHERE userId=?',[userId]))[0].lastError,null);
  pass('A failed fetch preserves the cursor, reports a sanitized error and recovers without losing the reply');

  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const waiting:typeof withWebmail=async(config,budget,work)=>{entered();await gate;return fake(config,budget,work);};
  const first=syncWebmail(userId,18000,waiting);await ready;
  try{await assert.rejects(syncWebmail(userId,18000,fake),/lượt khác/);}finally{release();}
  await first;
  pass('Concurrent sync attempts serialize using a database lock');

  const response=await fetch(base+'/api/mailbox/webmail',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,401);
  const cross=await fetch(base+'/api/mailbox/webmail',{method:'POST',headers:{Cookie:'mailtemp_session='+token,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(cross.status,403);
  const invalid=await fetch(base+'/api/mailbox/webmail',{method:'POST',headers:{Origin:base,Cookie:'mailtemp_session='+token,'Content-Type':'application/json'},body:JSON.stringify({...input,port:143})});assert.equal(invalid.status,400);
  await run('DELETE FROM mailboxes WHERE userId=?',[userId]);
  assert.equal((await rows('SELECT mailboxId FROM webmail_connections WHERE mailboxId=?',[stored.mailboxId])).length,0);
  pass('API authentication, same-origin, input validation and cascade credential deletion work');
  console.log(`Completed ${checks} Webmail check groups (${opens} read-only opens, ${fetches} fake fetches); no real email sent.`);
}finally{
  await run('DELETE FROM campaign_recipients WHERE campaignId=?',[campaignId]);await run('DELETE FROM campaigns WHERE id=?',[campaignId]);await run('DELETE FROM templates WHERE id=?',[templateId]);
  await run('DELETE FROM inbound_messages WHERE contactId=?',[contactId]);await run('DELETE FROM tasks WHERE ownerId IN (?,?)',[userId,otherId]);
  await run('DELETE FROM contacts WHERE accountId IN (?,?)',[accountId,otherAccount]);await run('DELETE FROM accounts WHERE id IN (?,?)',[accountId,otherAccount]);
  await run('DELETE FROM webhook_events WHERE eventId LIKE ?',['imap:'+userId+':%']);await run('DELETE FROM audit_logs WHERE actorId=?',[userId]);
  await run('DELETE FROM mailboxes WHERE userId IN (?,?)',[userId,otherId]);await run('DELETE FROM notifications WHERE userId IN (?,?)',[userId,otherId]);
  await run('DELETE FROM sessions WHERE userId IN (?,?)',[userId,otherId]);await run('DELETE FROM users WHERE id IN (?,?)',[userId,otherId]);
  await lock.query("SELECT RELEASE_LOCK('mailtemp_cron')");lock.release();await pool().end();
}

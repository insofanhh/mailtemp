// Only synthetic contacts are deleted. Never invokes SMTP or cron.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {rows,run,pool} from '../src/lib/db';
import {hash} from '../src/lib/session';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='BULK-QA-'+randomUUID().slice(0,8);
const owners=[randomUUID(),randomUUID()],accounts=[randomUUID(),randomUUID()],contacts=Array.from({length:205},()=>randomUUID()),foreign=randomUUID(),template=randomUUID(),product=randomUUID(),campaign=randomUUID();
const cookies:string[]=[];let checks=0;
const pass=(name:string)=>{checks++;console.log('PASS '+name);};
async function request(body:unknown,as=0,origin=base){return fetch(base+'/api/contacts/bulk-delete',{method:'POST',headers:{Origin:origin,...(cookies[as]?{Cookie:cookies[as]}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function api(ids:string[]){const response=await request({ids}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
try{
  for(let i=0;i<2;i++){
    await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[owners[i],prefix,prefix+i+'@example.com','session-test','sale']);
    await run('INSERT INTO accounts(id,name,ownerId) VALUES (?,?,?)',[accounts[i],prefix,owners[i]]);
    const token=randomBytes(32).toString('hex');cookies.push('mailtemp_session='+token);await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),owners[i]]);
  }
  await run(`INSERT INTO contacts(id,accountId,name,email,source) VALUES ${contacts.map(()=>'(?,?,?,?,?)').join(',')}`,contacts.flatMap((id,i)=>[id,accounts[0],prefix+' '+i,prefix.toLowerCase()+i+'@example.com','QA']));
  await run('INSERT INTO contacts(id,accountId,email,source) VALUES (?,?,?,?)',[foreign,accounts[1],prefix.toLowerCase()+'-foreign@example.com','QA']);
  assert.equal((await request({ids:[contacts[0]]},99)).status,401);assert.equal((await request({ids:[contacts[0]]},0,'https://wrong.example')).status,403);
  for(const body of [{ids:[]},{ids:contacts.slice(0,101)},{ids:['bad']},{all:true},{ids:[contacts[0]],all:true},null])assert.equal((await request(body)).status,400);
  pass('Authentication, same-origin, UUID validation and 100-contact limit');
  assert.equal((await request({ids:[contacts[0],foreign]})).status,403);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM contacts WHERE id IN (?,?)',[contacts[0],foreign]))[0].n),2);
  pass('Mixed-owner request rejects the entire operation without partial deletion');
  await run('INSERT INTO templates(id,name,subject,body) VALUES (?,?,?,?)',[template,prefix,'QA','QA']);
  await run('INSERT INTO products(id,name,destination,duration,validUntil,conditions) VALUES (?,?,?,?,?,?)',[product,prefix,'Huế','3N2Đ','2099-12-31','QA']);
  await run('INSERT INTO campaigns(id,name,ownerId,templateId,productId) VALUES (?,?,?,?,?)',[campaign,prefix,owners[0],template,product]);
  await run('INSERT INTO campaign_recipients(id,campaignId,contactId) VALUES (?,?,?)',[randomUUID(),campaign,contacts[1]]);
  await run('INSERT INTO inbound_messages(id,contactId,subject,body,receivedAt) VALUES (?,?,?,?,UTC_TIMESTAMP())',[randomUUID(),contacts[2],prefix,'QA']);
  const blockedEmail=prefix.toLowerCase()+'3@example.com';await run('INSERT INTO suppressions(id,email,reason,actorId) VALUES (?,?,?,?)',[randomUUID(),blockedEmail,'unsubscribe',owners[0]]);
  await run('INSERT INTO consent_events(id,contactId,actorId,status) VALUES (?,?,?,?)',[randomUUID(),contacts[4],owners[0],'unreviewed']);
  const result=await api(contacts.slice(0,100));assert.equal(result.deleted,98);assert.equal(result.skipped.length,2);assert.equal(result.missing,0);
  assert.deepEqual(new Set(result.skipped.map((item:{id:string})=>item.id)),new Set([contacts[1],contacts[2]]));
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM contacts WHERE accountId=?',[accounts[0]]))[0].n),107);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM contacts WHERE id IN ('+contacts.slice(100).map(()=>'?').join(',')+')',contacts.slice(100)))[0].n),105);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM consent_events WHERE contactId=?',[contacts[4]]))[0].n),0);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM suppressions WHERE email=?',[blockedEmail]))[0].n),1);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM accounts WHERE id=?',[accounts[0]]))[0].n),1);
  pass('100 selected contacts: 98 deleted, 2 protected; unselected contacts/accounts/suppressions preserved');
  const repeated=await api(contacts.slice(0,100));assert.equal(repeated.deleted,0);assert.equal(repeated.missing,98);assert.equal(repeated.skipped.length,2);
  const missing=await api([randomUUID()]);assert.equal(missing.deleted,0);assert.equal(missing.missing,1);
  const unique=await api([contacts[100],contacts[100]]);assert.equal(unique.deleted,1);
  const concurrent=await Promise.all([api(contacts.slice(101,111)),api(contacts.slice(101,111))]);assert.equal(concurrent.reduce((sum,value)=>sum+value.deleted,0),10);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM audit_logs WHERE actorId=? AND action=?',[owners[0],'contacts_bulk_deleted']))[0].n),3);
  pass('Retries, duplicate IDs and concurrent requests do not delete extra contacts or duplicate audits');
  console.log(`Completed ${checks} bulk-delete checks. No email sent.`);
}finally{
  await run('DELETE FROM campaign_recipients WHERE campaignId=?',[campaign]);await run('DELETE FROM campaigns WHERE id=?',[campaign]);
  for(const accountId of accounts){await run('DELETE FROM inbound_messages WHERE contactId IN (SELECT id FROM contacts WHERE accountId=?)',[accountId]);await run('DELETE FROM consent_events WHERE contactId IN (SELECT id FROM contacts WHERE accountId=?)',[accountId]);await run('DELETE FROM contacts WHERE accountId=?',[accountId]);await run('DELETE FROM accounts WHERE id=?',[accountId]);}
  await run('DELETE FROM templates WHERE id=?',[template]);await run('DELETE FROM products WHERE id=?',[product]);await run('DELETE FROM suppressions WHERE email LIKE ?',[prefix.toLowerCase()+'%']);
  for(const id of owners){await run('DELETE FROM audit_logs WHERE actorId=?',[id]);await run('DELETE FROM notifications WHERE userId=?',[id]);await run('DELETE FROM users WHERE id=?',[id]);}await pool().end();
}

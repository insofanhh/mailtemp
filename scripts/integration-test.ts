import nextEnv from '@next/env';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {io,type Socket} from 'socket.io-client';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
import {unsubscribeToken} from '../src/lib/mail';
nextEnv.loadEnvConfig(process.cwd());

const base=process.env.APP_URL||'http://localhost:3000',prefix='QA-'+randomUUID().slice(0,8),adminId=randomUUID(),saleId=randomUUID();
const cookies:Record<string,string>={},accountIds:string[]=[],campaignIds:string[]=[],productIds:string[]=[],templateIds:string[]=[],eventIds:string[]=[],testEmails:string[]=[],notifications:number[]=[],sockets:Socket[]=[];
const rfqIds:string[]=[];
let checks=0;
function check(name:string){checks++;console.log('PASS '+name);}
async function request(path:string,body?:unknown,as='admin',method=body===undefined?'GET':'POST',extra:Record<string,string>={}){
  return fetch(base+path,{method,headers:{Origin:base,...(cookies[as]?{Cookie:cookies[as]}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function api(path:string,body?:unknown,as='admin',method?:string){const response=await request(path,body,as,method);const value=await response.json();assert.equal(response.status,200,`${path}: ${JSON.stringify(value)}`);return value;}
async function signedEvent(event:Record<string,unknown>){eventIds.push(String(event.eventId));const timestamp=String(Date.now()),raw=JSON.stringify(event);return request('/api/events',event,'none','POST',{'x-mailtemp-timestamp':timestamp,'x-mailtemp-signature':createHmac('sha256',process.env.WEBHOOK_SECRET!).update(timestamp+'.'+raw).digest('hex')});}
async function createCampaign(contactId:string,templateId:string,productId:string){const item=await api('/api/campaigns',{name:prefix,contactIds:[contactId],templateId,productId,followupBody:'Xin chào {{ company_name }}',followupDays:4});campaignIds.push(item.id);return item.id as string;}
async function eligible(id:string){await api('/api/contacts/'+id,{consentStatus:'eligible',consentPurpose:'Nhận bảng giá tour theo đăng ký',consentEvidence:'Phiếu đăng ký thử nghiệm tích hợp'},'admin','PATCH');}
async function connectSocket(cookie?:string){const socket=io(base,{transports:['websocket'],extraHeaders:{Origin:base,...(cookie?{Cookie:cookie}:{})},reconnection:false,autoConnect:false});sockets.push(socket);return socket;}
function once(socket:Socket,event:string){return new Promise<unknown>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Socket timeout: '+event)),6000);socket.once(event,value=>{clearTimeout(timeout);resolve(value);});});}
try{
  assert.notEqual(process.env.MAIL_ENABLED,'true','Tests require MAIL_ENABLED=false');
  for(const [id,role] of [[adminId,'admin'],[saleId,'sale']]){
    await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[id,prefix+' '+role,prefix+'-'+role+'@example.com',await bcrypt.hash(randomBytes(20).toString('hex'),4),role]);
    const token=randomBytes(32).toString('hex');await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),id]);cookies[role]='mailtemp_session='+token;
  }
  assert.equal((await request('/api/state',undefined,'none')).status,401);
  assert.equal((await request('/api/tasks',{title:'x'},'admin','POST',{Origin:'https://evil.example'})).status,403);check('Authentication and CSRF boundaries');
  const account=await api('/api/accounts',{name:prefix+' Agency'});accountIds.push(account.id);
  const email=prefix.toLowerCase()+'@example.com';testEmails.push(email);
  const contact=await api('/api/contacts',{accountId:account.id,email,name:'QA Contact',source:'https://example.com'});
  assert.equal((await rows('SELECT consentStatus FROM contacts WHERE id=?',[contact.id]))[0].consentStatus,'unreviewed');
  assert.equal((await request('/api/accounts/'+account.id,{stage:'qualified'},'sale','PATCH')).status,403);
  const saleState=await api('/api/state',undefined,'sale');assert.equal(saleState.accounts.some((a:{id:string})=>a.id===account.id),false);check('Sale ownership and new-contact eligibility');
  const productBody={name:prefix,destination:'Đà Nẵng',duration:'3N2Đ',price:2000000,validUntil:'2099-12-31',conditions:'Điều kiện thử nghiệm'};
  const product=await api('/api/products',productBody);productIds.push(product.id);
  const template=await api('/api/templates',{name:prefix,subject:'Bảng giá {{ company_name }}',body:'Chào {{ contact_name }} · {{ price }}'});templateIds.push(template.id);
  const campaignId=await createCampaign(contact.id,template.id,product.id);
  assert.equal((await request('/api/campaigns/'+campaignId,{action:'approve'},'admin','PATCH')).status,409);check('Unreviewed contacts cannot be approved for sending');
  await eligible(contact.id);
  const competitor=await createCampaign(contact.id,template.id,product.id);
  const approvals=await Promise.all([request('/api/campaigns/'+campaignId,{action:'approve'},'admin','PATCH'),request('/api/campaigns/'+competitor,{action:'approve'},'admin','PATCH')]);
  assert.equal(approvals.filter(r=>r.status===200).length,1);assert.equal(approvals.filter(r=>r.status===409).length,1);check('Concurrent approvals cannot target the same agency');
  const activeId=approvals[0].status===200?campaignId:competitor;
  await api('/api/products/'+product.id,{...productBody,price:2100000},'admin','PATCH');
  assert.equal((await rows('SELECT status FROM campaigns WHERE id=?',[activeId]))[0].status,'draft');
  assert.equal((await rows('SELECT COUNT(*) n FROM product_versions WHERE productId=?',[product.id]))[0].n,1);
  await api('/api/campaigns/'+activeId,{action:'approve'},'admin','PATCH');
  await api('/api/templates/'+template.id,{name:prefix,subject:'Mới {{ company_name }}',body:'Chào {{ contact_name }}'},'admin','PATCH');
  assert.equal((await rows('SELECT status FROM campaigns WHERE id=?',[activeId]))[0].status,'draft');check('Price/template changes invalidate approvals and preserve price history');
  await api('/api/campaigns/'+activeId,{action:'approve'},'admin','PATCH');
  await api('/api/campaigns/'+activeId,{action:'schedule',scheduledAt:new Date().toISOString()},'admin','PATCH');
  assert.equal((await request('/api/campaigns/'+activeId,{action:'approve'},'admin','PATCH')).status,409);
  assert.equal((await request('/api/campaign-test/'+activeId,{email:'outsider@example.com',contactId:contact.id})).status,409);check('Test emails require an explicit server-side internal allowlist');
  assert.equal((await request('/api/cron',{},'none')).status,401);
  const lock=await pool().getConnection();await lock.query("SELECT GET_LOCK('mailtemp_cron',0)");
  try{const response=await request('/api/cron',{},'none','POST',{Authorization:'Bearer '+process.env.CRON_SECRET});assert.equal(response.status,200);assert.equal((await response.json()).busy,true);}finally{await lock.query("SELECT RELEASE_LOCK('mailtemp_cron')");lock.release();}
  const cron=await request('/api/cron',{},'none','POST',{Authorization:'Bearer '+process.env.CRON_SECRET});assert.equal(cron.status,200);assert.equal((await cron.json()).processed,0);
  assert.equal((await rows('SELECT attempts FROM campaign_recipients WHERE campaignId=?',[activeId]))[0].attempts,0);check('Cron authentication and disabled-mail mode prevent dispatch');
  const rfq=await api('/api/rfqs',{accountId:account.id,title:prefix,destination:'Huế',pax:20});rfqIds.push(rfq.id);
  const form=new FormData();form.set('file',new Blob(['%PDF-1.4\n%%EOF'],{type:'application/pdf'}),'qa.pdf');
  const uploaded=await fetch(base+'/api/files?type=rfq&parentId='+rfq.id,{method:'POST',headers:{Origin:base,Cookie:cookies.admin},body:form});assert.equal(uploaded.status,200);const file=await uploaded.json();
  assert.equal((await request('/api/files?id='+file.id,undefined,'none')).status,401);
  assert.equal((await request('/api/files?id='+file.id,undefined,'sale')).status,403);
  assert.equal((await request('/api/files?id='+file.id)).headers.get('content-type'),'application/pdf');check('Private PDF downloads enforce account ownership');
  const reply={eventId:prefix+'-reply',type:'reply',email,subject:'Xin bảng giá',body:'Cần tour đoàn',userId:adminId};
  assert.equal((await signedEvent(reply)).status,200);const duplicate=await signedEvent(reply);assert.equal((await duplicate.json()).duplicate,true);
  assert.equal((await rows('SELECT COUNT(*) n FROM inbound_messages WHERE contactId=?',[contact.id]))[0].n,1);
  assert.equal((await rows('SELECT status FROM campaign_recipients WHERE campaignId=?',[activeId]))[0].status,'skipped');check('Reply events are idempotent and stop queued follow-up');
  await run("UPDATE campaign_recipients SET status='sending',claimedAt=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 5 MINUTE),attempts=1 WHERE campaignId=?",[activeId]);
  for(let i=0;i<2;i++)assert.equal((await request('/api/cron',{},'none','POST',{Authorization:'Bearer '+process.env.CRON_SECRET})).status,200);
  const [uncertain]=await rows('SELECT id,status,attempts FROM campaign_recipients WHERE campaignId=?',[activeId]);assert.equal(uncertain.status,'unknown');assert.equal(uncertain.attempts,1);
  assert.equal((await request('/api/reconcile/'+uncertain.id,{result:'not_sent',evidence:'Provider log xác nhận không có thư này'},'sale')).status,403);
  await api('/api/reconcile/'+uncertain.id,{result:'not_sent',evidence:'Provider log xác nhận không có thư này'});
  assert.equal((await rows('SELECT status FROM campaign_recipients WHERE id=?',[uncertain.id]))[0].status,'skipped');check('Interrupted sends stay unknown until documented admin reconciliation; no automatic retry');
  const unsubscribe=base+'/api/unsubscribe?token='+unsubscribeToken(contact.id);
  await fetch(unsubscribe);assert.equal((await rows('SELECT COUNT(*) n FROM suppressions WHERE email=?',[email]))[0].n,0);
  await fetch(unsubscribe,{method:'POST'});assert.equal((await rows('SELECT COUNT(*) n FROM suppressions WHERE email=?',[email]))[0].n,1);
  assert.equal((await request('/api/contacts/'+contact.id,{consentStatus:'eligible',consentPurpose:'Nhận bảng giá hàng tháng',consentEvidence:'Cố bật lại sau khi chặn'},'admin','PATCH')).status,409);check('Unsubscribe GET is inert; POST suppression cannot be overridden by review');
  const importEmail=prefix.toLowerCase()+'-import@example.com';testEmails.push(importEmail);
  await run('INSERT INTO suppressions(id,email,reason) VALUES (?,?,?)',[randomUUID(),importEmail,'manual']);
  const imported=await api('/api/import',{filename:prefix+'.csv',records:[{company:prefix+' Agency',email:importEmail,source:'Company list',consentStatus:'eligible'}]});assert.equal(imported.imported,1);
  assert.equal((await rows('SELECT consentStatus FROM contacts WHERE email=?',[importEmail]))[0].consentStatus,'suppressed');check('Import cannot restore suppressed addresses');
  const badSocket=await connectSocket();const rejected=once(badSocket,'connect_error');badSocket.connect();await rejected;
  const goodSocket=await connectSocket(cookies.admin);const ready=once(goodSocket,'ready');goodSocket.connect();await ready;
  const event=once(goodSocket,'workspace:changed');const notification=await run('INSERT INTO notifications(userId,title) VALUES (?,?)',[adminId,prefix+' realtime']);notifications.push(notification.insertId);await event;check('WebSocket authentication and durable realtime notifications');
  const global=await run('INSERT INTO notifications(title) VALUES (?)',[prefix+' global']);notifications.push(global.insertId);
  await api('/api/notifications',{});
  const adminState=await api('/api/state'),freshSale=await api('/api/state',undefined,'sale');
  assert.ok(adminState.notifications.find((n:{id:number;readAt:string|null})=>n.id===global.insertId)?.readAt);
  assert.equal(freshSale.notifications.find((n:{id:number;readAt:string|null})=>n.id===global.insertId)?.readAt,null);check('Global notification read state is per user');
  console.log(`Completed ${checks} integration checks. No email sent.`);
}finally{
  for(const socket of sockets)socket.disconnect();
  // Delete only fixtures scoped to unique test IDs; keep workspace/demo data.
  for(const id of rfqIds){await run("DELETE FROM private_files WHERE parentType='rfq' AND parentId=?",[id]);await run('DELETE FROM rfqs WHERE id=?',[id]);}
  for(const id of campaignIds){await run('DELETE FROM campaign_recipients WHERE campaignId=?',[id]);await run('DELETE FROM campaigns WHERE id=?',[id]);}
  for(const id of accountIds){await run('DELETE FROM tasks WHERE accountId=?',[id]);await run('DELETE FROM inbound_messages WHERE contactId IN (SELECT id FROM contacts WHERE accountId=?)',[id]);await run('DELETE FROM consent_events WHERE contactId IN (SELECT id FROM contacts WHERE accountId=?)',[id]);await run('DELETE FROM contacts WHERE accountId=?',[id]);await run('DELETE FROM accounts WHERE id=?',[id]);}
  for(const email of testEmails)await run('DELETE FROM suppressions WHERE email=?',[email]);
  for(const id of productIds){await run('DELETE FROM product_versions WHERE productId=?',[id]);await run('DELETE FROM products WHERE id=?',[id]);}
  for(const id of templateIds)await run('DELETE FROM templates WHERE id=?',[id]);
  for(const id of eventIds)await run('DELETE FROM webhook_events WHERE eventId=?',[id]);
  for(const id of [adminId,saleId]){await run('DELETE FROM import_batches WHERE actorId=?',[id]);await run('DELETE FROM audit_logs WHERE actorId=?',[id]);await run('DELETE FROM notifications WHERE userId=?',[id]);await run('DELETE FROM users WHERE id=?',[id]);}
  await run('DELETE FROM notifications WHERE title LIKE ?',[prefix+'%']);
  await run('DELETE FROM audit_logs WHERE entityId IN ('+testEmails.map(()=>'?').join(',')+')',testEmails).catch(()=>{});
  await pool().end();
}

// CRUD integration only. This script never calls cron, SMTP or campaign approval.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='CRUD-QA-'+randomUUID().slice(0,8);
const users=[randomUUID(),randomUUID(),randomUUID()],cookies:Record<string,string>={};
const created:Record<string,string[]>={accounts:[],contacts:[],products:[],templates:[],campaigns:[],tasks:[],rfqs:[],quotes:[],messages:[],users:[],suppressions:[]};
let checks=0;
function pass(name:string){checks++;console.log('PASS '+name);}
async function session(id:string,as:string){const token=randomBytes(32).toString('hex');cookies[as]='mailtemp_session='+token;await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),id]);}
async function request(path:string,body?:unknown,as='sale',method=body===undefined?'GET':'POST',origin=base){return fetch(base+'/api/'+path,{method,headers:{Origin:origin,...(cookies[as]?{Cookie:cookies[as]}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function api(path:string,body?:unknown,as='sale',method?:string){const response=await request(path,body,as,method),value=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(value));return value;}
async function status(path:string,expected:number,body?:unknown,as='sale',method?:string){const response=await request(path,body,as,method);assert.equal(response.status,expected,path+': '+await response.text());}
async function create(resource:string,body:unknown,as='sale'){const item=await api(resource,body,as);created[resource].push(item.id);return item.id as string;}
async function remove(resource:string,id:string,as='sale',body:unknown={}){await api(resource+'/'+id,body,as,'DELETE');await status(resource+'/'+id,404,undefined,as);}
try{
  for(let i=0;i<users.length;i++){
    await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[users[i],prefix+' '+i,prefix+i+'@example.com','session-only-test',i===0?'admin':'sale']);await session(users[i],['admin','sale','other'][i]);
  }
  await status('accounts',401,undefined,'none');assert.equal((await request('contacts/'+randomUUID(),{},'sale','DELETE','https://evil.example')).status,403);
  const accountBody={name:prefix+' Agency',website:'https://example.com',region:'Hà Nội',market:'Việt Nam',segment:'MICE',tier:'Tiêu chuẩn',notes:'QA'};
  const account=await create('accounts',accountBody),foreign=await create('accounts',{...accountBody,name:prefix+' Foreign'},'other');
  for(const method of ['GET','PATCH','DELETE'])await status('accounts/'+foreign+(method==='PATCH'?'/details':''),403,method==='GET'?undefined:{...accountBody,stage:'new'},'sale',method);
  await api('accounts/'+account+'/details',{...accountBody,name:prefix+' Edited Agency',stage:'qualified'},'sale','PATCH');assert.equal((await api('accounts/'+account)).name,prefix+' Edited Agency');
  pass('Accounts create/read/edit + authentication, CSRF and ownership');
  const contactBody={accountId:account,name:prefix+' Contact',email:prefix.toLowerCase()+'@example.com',title:'Sales',source:'QA website',country:'VN'};
  const contact=await create('contacts',contactBody);const foreignContact=await create('contacts',{...contactBody,accountId:foreign,email:prefix.toLowerCase()+'-foreign@example.com'},'other');
  await status('contacts/'+foreignContact,403);await status('contacts/'+foreignContact+'/details',403,contactBody,'sale','PATCH');
  await api('contacts/'+contact+'/details',{...contactBody,name:prefix+' Contact Edited',title:'Director',consentStatus:'eligible'},'sale','PATCH');assert.equal((await api('contacts/'+contact)).consentStatus,'unreviewed');
  const changedContact={...contactBody,email:prefix.toLowerCase()+'-changed@example.com',source:'QA new website'};
  await api('contacts/'+contact,{consentStatus:'eligible',consentPurpose:'QA explicit subscription purpose',consentEvidence:'QA explicit subscription evidence'},'sale','PATCH');
  await api('contacts/'+contact+'/details',changedContact,'sale','PATCH');const changed=await api('contacts/'+contact);assert.equal(changed.consentStatus,'unreviewed');assert.equal(changed.consentEvidence,'');
  pass('Contacts edit full details and reset consent after identity/source change');
  const taskBody={title:prefix+' Task',accountId:account,dueAt:'2099-12-01T10:00:00+07:00',priority:'normal'};
  const task=await create('tasks',taskBody);await api('tasks/'+task+'/details',{...taskBody,title:prefix+' Task Edited',status:'done',priority:'high'},'sale','PATCH');assert.equal((await api('tasks/'+task)).status,'done');await status('tasks/'+task,403,{},'other','DELETE');
  const productBody={name:prefix+' Tour',destination:'Đà Nẵng',duration:'3N2Đ',price:2000000,currency:'VND',unit:'khách',tier:'Tiêu chuẩn',validUntil:'2099-12-31',conditions:'QA conditions'};
  const product=await create('products',productBody);await api('products/'+product,{...productBody,price:2100000},'sale','PATCH');assert.equal((await api('products/'+product)).version,2);
  const templateBody={name:prefix+' Template',subject:'Hello {{ company_name }}',body:'Xin chào {{ contact_name }}',category:'QA'};
  const template=await create('templates',templateBody);await api('templates/'+template,{...templateBody,subject:'Updated {{ company_name }}'},'sale','PATCH');assert.equal((await api('templates/'+template)).version,2);await status('templates/'+randomUUID(),404,templateBody,'sale','PATCH');
  pass('Tasks, tours and templates create/read/update, including version history');
  const campaignBody={name:prefix+' Campaign',templateId:template,productId:product,contactIds:[contact],followupBody:'',followupDays:4};
  const campaign=await create('campaigns',campaignBody);await api('campaigns/'+campaign+'/details',{...campaignBody,name:prefix+' Campaign Edited'},'sale','PATCH');assert.equal((await api('campaigns/'+campaign)).campaign.name,prefix+' Campaign Edited');
  await status('contacts/'+contact,409,{},'sale','DELETE');await status('products/'+product,409,{},'sale','DELETE');await status('templates/'+template,409,{},'sale','DELETE');
  await status('contacts/'+contact+'/details',409,{...changedContact,email:prefix.toLowerCase()+'-different@example.com'},'sale','PATCH');
  await run("UPDATE campaigns SET status='approved' WHERE id=?",[campaign]);await status('campaigns/'+campaign+'/details',409,campaignBody,'sale','PATCH');await status('campaigns/'+campaign,409,{},'sale','DELETE');
  await run("UPDATE campaigns SET status='cancelled' WHERE id=?",[campaign]);await run("UPDATE campaign_recipients SET attempts=1,status='unknown' WHERE campaignId=?",[campaign]);await status('campaigns/'+campaign,409,{},'sale','DELETE');
  await run("UPDATE campaigns SET status='draft' WHERE id=?",[campaign]);await run("UPDATE campaign_recipients SET attempts=0,status='pending' WHERE campaignId=?",[campaign]);
  pass('Campaign draft edit and protected relationships/delivery history');
  const email=changedContact.email;
  await api('suppressions',{email,reason:'manual'},'admin');let suppression=(await rows('SELECT id FROM suppressions WHERE email=?',[email]))[0].id;created.suppressions.push(suppression);
  await status('suppressions/'+suppression,403,{evidence:'QA removal evidence and explicit operator confirmation'},'sale','DELETE');
  await status('suppressions/'+suppression,400,{evidence:'short'},'admin','DELETE');
  await api('suppressions/'+suppression,{reason:'manual'},'admin','PATCH');await remove('suppressions',suppression,'admin',{evidence:'QA removal evidence and explicit operator confirmation'});assert.equal((await api('contacts/'+contact)).consentStatus,'unreviewed');
  await api('suppressions',{email,reason:'manual'},'admin');suppression=(await rows('SELECT id FROM suppressions WHERE email=?',[email]))[0].id;created.suppressions.push(suppression);
  const messageBody={contactId:contact,subject:prefix+' Reply',body:'QA received response',receivedAt:new Date().toISOString(),classification:'positive'};
  const message=await create('messages',messageBody);assert.ok((await api('contacts/'+contact)).lastReplyAt);assert.equal((await rows('SELECT status FROM campaign_recipients WHERE campaignId=?',[campaign]))[0].status,'skipped');
  await api('messages/'+message+'/details',{...messageBody,body:'QA updated content',classification:'unsubscribe'},'sale','PATCH');assert.equal((await api('messages/'+message)).body,'QA updated content');
  assert.equal((await rows('SELECT reason FROM suppressions WHERE id=?',[suppression]))[0].reason,'unsubscribe');await status('suppressions/'+suppression,409,{evidence:'QA cannot remove a recorded recipient unsubscribe'},'admin','DELETE');
  await status('suppressions/'+suppression,409,{reason:'manual'},'admin','PATCH');await remove('messages',message);assert.equal((await api('contacts/'+contact)).consentStatus,'suppressed');
  pass('Replies CRUD stop follow-ups; manual unblock requires admin/evidence; recipient refusal survives delete');
  const rfqBody={accountId:account,title:prefix+' RFQ',destination:'Huế',pax:20,budget:10000000,notes:'QA'};
  const rfq=await create('rfqs',rfqBody);await api('rfqs/'+rfq+'/details',{...rfqBody,title:prefix+' RFQ Edited',status:'working',bookingReference:'',revenue:0,grossMargin:0},'sale','PATCH');assert.equal((await api('rfqs/'+rfq)).status,'working');
  await status('rfqs/'+rfq+'/details',400,{...rfqBody,status:'won'},'sale','PATCH');
  const quoteBody={rfqId:rfq,amount:30000000,currency:'VND',validUntil:'2099-12-31',conditions:'QA quote'};
  const quote=await create('quotes',quoteBody);await api('quotes/'+quote,{...quoteBody,amount:31000000},'sale','PATCH');assert.equal(Number((await api('quotes/'+quote)).amount),31000000);await status('quotes/'+quote,403,undefined,'other');await status('rfqs/'+rfq,409,{},'sale','DELETE');await remove('quotes',quote);
  const nextQuote=await create('quotes',quoteBody);assert.equal((await api('quotes/'+nextQuote)).version,2);await remove('quotes',nextQuote);
  pass('RFQs and quotes CRUD, booking validation and monotonic quote versions');
  const form=new FormData();form.set('file',new Blob(['%PDF-1.4\n%%EOF']),'qa.pdf');const uploaded=await fetch(base+'/api/files?type=rfq&parentId='+rfq,{method:'POST',headers:{Origin:base,Cookie:cookies.sale},body:form});assert.equal(uploaded.status,200);const file=await uploaded.json();
  await api('files?id='+file.id,{filename:'renamed.pdf'},'sale','PATCH');assert.equal((await api('files?type=rfq&parentId='+rfq))[0].filename,'renamed.pdf');await status('files?id='+file.id,403,{},'other','DELETE');await status('files?id='+file.id,400,{filename:'../bad.pdf'},'sale','PATCH');await api('files?id='+file.id,{},'sale','DELETE');await status('files?id='+file.id,404);
  pass('Private PDF upload/read/rename/delete and ownership');
  const memberBody={name:prefix+' Member',email:prefix.toLowerCase()+'-member@example.com',password:'QA-Member-Only-2026!',role:'sale'};
  const member=await create('users',memberBody,'admin');await session(member,'member');assert.equal((await request('state',undefined,'member')).status,200);
  await status('users/'+member,403,undefined,'sale');await api('users/'+member,{name:prefix+' Member Edited',email:memberBody.email,role:'sale',active:false},'admin','PATCH');await status('state',401,undefined,'member');assert.equal((await api('users/'+member,undefined,'admin')).active,0);
  await status('users/'+users[0],409,{name:prefix+' Admin',email:prefix+'0@example.com',role:'sale',active:true},'admin','PATCH');await status('users/'+users[0],409,{},'admin','DELETE');await remove('users',member,'admin');
  pass('Members CRUD, admin permissions, self-protection and session revocation');
  for(const resource of Object.keys(created)){
    const values=await api(resource,undefined,resource==='users'?'admin':'sale');assert.ok(Array.isArray(values));
  }
  await remove('campaigns',campaign);await remove('tasks',task);await remove('rfqs',rfq);await remove('contacts',contact);await remove('contacts',foreignContact,'other');await remove('accounts',account);await remove('accounts',foreign,'other');await remove('products',product);await remove('templates',template);
  await status('accounts/'+account+'/details',404,{...accountBody,stage:'new'},'sale','PATCH');
  assert.equal((await rows('SELECT COUNT(*) n FROM suppressions WHERE email=?',[email]))[0].n,1);
  pass('All business lists readable; complete dependency-ordered deletion; suppression persists');
  console.log(`Completed ${checks} CRUD checks. No email sent.`);
}finally{
  // Clean up only fixture IDs, including records intentionally protected by API checks.
  const drop=async(table:string,column:string,ids:string[])=>{if(ids.length)await run(`DELETE FROM ${table} WHERE ${column} IN (${ids.map(()=>'?').join(',')})`,ids);};
  await drop('campaign_recipients','campaignId',created.campaigns);await drop('campaigns','id',created.campaigns);
  await drop('private_files','actorId',users);await drop('quotes','id',created.quotes);await drop('inbound_messages','id',created.messages);await drop('consent_events','contactId',created.contacts);await drop('contacts','id',created.contacts);await drop('tasks','id',created.tasks);await drop('rfqs','id',created.rfqs);await drop('accounts','id',created.accounts);await drop('product_versions','productId',created.products);await drop('products','id',created.products);await drop('templates','id',created.templates);await drop('suppressions','id',created.suppressions);
  for(const id of created.rfqs)await run('DELETE FROM settings WHERE settingKey=?',['quote_sequence_'+id]);
  await drop('audit_logs','actorId',users);await drop('notifications','userId',users);await run('DELETE FROM notifications WHERE body LIKE ?',[prefix+'%']);await drop('users','id',[...created.users,...users]);await pool().end();
}

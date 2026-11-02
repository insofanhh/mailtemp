// Isolated fixtures only. Never invokes SMTP, cron, approval or scheduling.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {hash,type User} from '../src/lib/session';
import {readAssistantContext} from '../src/lib/assistant-context';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='DELETE-QA-'+randomUUID().slice(0,8);
const users=[randomUUID(),randomUUID(),randomUUID()],cookies:Record<string,string>={};
const created:Record<string,string[]>={accounts:[],contacts:[],products:[],templates:[],campaigns:[],tasks:[],rfqs:[],quotes:[],messages:[],suppressions:[]};
let checks=0;
function pass(name:string){console.log('PASS '+(++checks)+' '+name);}
async function request(path:string,body?:unknown,as='sale',method=body===undefined?'GET':'POST'){
  return fetch(base+'/api/'+path,{method,headers:{Origin:base,Cookie:cookies[as],...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function api(path:string,body?:unknown,as='sale',method?:string){const r=await request(path,body,as,method),value=await r.json();assert.equal(r.status,200,path+': '+JSON.stringify(value));return value;}
async function status(path:string,expected:number,body?:unknown,as='sale',method?:string){const r=await request(path,body,as,method);assert.equal(r.status,expected,path+': '+await r.text());}
async function create(resource:string,body:unknown,as='sale'){const {id}=await api(resource,body,as);created[resource].push(id);return id as string;}
try{
  for(let i=0;i<users.length;i++){
    await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[users[i],prefix+' '+i,prefix+i+'@example.com','fixture-session-only',i===0?'admin':'sale']);
    const token=randomBytes(32).toString('hex');cookies[['admin','sale','other'][i]]='mailtemp_session='+token;
    await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),users[i]]);
  }
  const account=await create('accounts',{name:prefix+' Agency'}),otherAccount=await create('accounts',{name:prefix+' Unchanged'});
  const email=prefix.toLowerCase()+'@example.com';
  const contact=await create('contacts',{accountId:account,email,name:'QA Contact',source:'QA',country:'VN'});
  const otherContact=await create('contacts',{accountId:otherAccount,email:prefix.toLowerCase()+'-other@example.com'});
  const task=await create('tasks',{accountId:account,title:prefix+' Task',dueAt:'2099-12-01T00:00:00Z',priority:'normal'});
  const rfq=await create('rfqs',{accountId:account,title:prefix+' RFQ',destination:'Huế',pax:10});
  const quote=await create('quotes',{rfqId:rfq,amount:10000000,currency:'VND',validUntil:'2099-12-31',conditions:'QA'});
  const message=await create('messages',{contactId:contact,subject:prefix+' Reply',body:'Historical reply',receivedAt:new Date().toISOString()});
  const product=await create('products',{name:prefix+' Tour',destination:'Huế',duration:'3N2Đ',price:1000000,tier:'Tiêu chuẩn',validUntil:'2099-12-31',conditions:'QA'});
  const template=await create('templates',{name:prefix+' Template',subject:'Xin chào',body:'Bảng giá du lịch',category:'QA'});
  const campaignBody={name:prefix+' Campaign',templateId:template,productId:product,contactIds:[contact,otherContact],followupDays:4};
  const campaign=await create('campaigns',campaignBody);
  await api('suppressions',{email,reason:'manual'},'admin');created.suppressions.push((await rows('SELECT id FROM suppressions WHERE email=?',[email]))[0].id);
  await run("INSERT INTO consent_events(id,contactId,actorId,status,evidence) VALUES (?,?,?,'eligible','Historical evidence')",[randomUUID(),contact,users[1]]);
  await run('INSERT INTO private_files(id,parentType,parentId,filename,content,size,actorId) VALUES (?,\'rfq\',?,\'qa.pdf\',?,3,?)',[randomUUID(),rfq,Buffer.from('PDF'),users[1]]);
  await status('accounts/'+account,403,{},'other','DELETE');
  assert.equal((await rows('SELECT deletedAt FROM accounts WHERE id=?',[account]))[0].deletedAt,null);
  pass('Foreign sale cannot delete agency; all data unchanged');
  await run("UPDATE campaign_recipients SET status='sending',attempts=1 WHERE campaignId=? AND contactId=?",[campaign,contact]);
  await status('accounts/'+account,409,{},'sale','DELETE');
  assert.equal((await rows('SELECT deletedAt FROM accounts WHERE id=?',[account]))[0].deletedAt,null);
  assert.equal((await rows('SELECT status FROM campaign_recipients WHERE campaignId=? AND contactId=?',[campaign,otherContact]))[0].status,'pending');
  pass('In-flight email blocks deletion without partial changes');
  await run("UPDATE campaign_recipients SET status='accepted',sentAt=UTC_TIMESTAMP(3),messageId=? WHERE campaignId=? AND contactId=?",['<'+randomUUID()+'@example.com>',campaign,contact]);
  await run("INSERT INTO campaign_recipients(id,campaignId,contactId,step,status) VALUES (?,?,?,1,'pending'),(?,?,?,2,'unknown')",[randomUUID(),campaign,contact,randomUUID(),campaign,contact]);
  const result=await api('accounts/'+account,{},'sale','DELETE');
  assert.equal(result.softDeleted,true);assert.equal(result.stoppedRecipients,1);
  const recipients=await rows('SELECT contactId,step,status FROM campaign_recipients WHERE campaignId=?',[campaign]);
  assert.equal(recipients.find(r=>r.contactId===contact&&r.step===0)?.status,'accepted');
  assert.equal(recipients.find(r=>r.contactId===contact&&r.step===1)?.status,'skipped');
  assert.equal(recipients.find(r=>r.contactId===contact&&r.step===2)?.status,'unknown');
  assert.equal(recipients.find(r=>r.contactId===otherContact)?.status,'pending');
  assert.ok((await rows('SELECT deletedAt FROM accounts WHERE id=?',[account]))[0].deletedAt);
  for(const [table,id]of [['contacts',contact],['tasks',task],['rfqs',rfq],['quotes',quote],['inbound_messages',message]])assert.equal((await rows(`SELECT COUNT(*) n FROM ${table} WHERE id=?`,[id]))[0].n,1);
  for(const [table,column,id]of [['consent_events','contactId',contact],['private_files','parentId',rfq],['suppressions','email',email]])assert.equal((await rows(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`,[id]))[0].n,1);
  pass('Agency with contacts, tasks, RFQ, quote, reply and deliveries deletes; history and other recipients survive');
  for(const as of ['sale','admin']){
    const state=await api('state',undefined,as);
    for(const [resource,id]of [['accounts',account],['contacts',contact],['tasks',task],['rfqs',rfq],['quotes',quote],['messages',message]])assert.ok(!state[resource].some((row:{id:string})=>row.id===id),resource+' hidden for '+as);
    assert.ok(state.accounts.some((row:{id:string})=>row.id===otherAccount));
    assert.ok(state.suppressions.some((row:{email:string})=>row.email===email));
    const csv=await request('export',undefined,as);assert.equal(csv.status,200);assert.ok(!(await csv.text()).includes(email));
  }
  pass('Hidden from admin/sale active lists, selectors and CSV; suppression remains visible');
  for(const [resource,id]of [['accounts',account],['contacts',contact],['tasks',task],['rfqs',rfq],['quotes',quote],['messages',message]])await status(resource+'/'+id,404);
  await status('accounts/'+account,404,{},'sale','DELETE');
  await status('accounts/'+account,404,{notes:'Should not edit'},'sale','PATCH');
  await status('contacts',404,{accountId:account,email:prefix.toLowerCase()+'-new@example.com'});
  await status('tasks',404,{accountId:account,title:'No new task',dueAt:'2099-12-01T00:00:00Z'});
  await status('tasks/'+task,404,{status:'done'},'sale','PATCH');
  await status('rfqs',404,{accountId:account,title:'No new RFQ',destination:'Huế',pax:1});
  await status('quotes',404,{rfqId:rfq,amount:1,validUntil:'2099-12-31',conditions:'QA'});
  pass('Deleted profiles cannot be read, edited, deleted again or receive new dependent records');
  const preview=await api('campaigns/'+campaign);assert.equal(preview.recipients.find((r:{id:string})=>r.id===contact).reason,'Đại lý đã bị xóa.');
  await status('campaigns',409,{...campaignBody,contactIds:[contact]});
  await status('campaigns/'+campaign+'/details',409,{...campaignBody,contactIds:[contact]},'sale','PATCH');
  assert.deepEqual(await api('contacts/bulk-delete',{ids:[contact]}),{deleted:0,skipped:[],missing:1});
  pass('Campaign preview blocks deleted agency, campaign create/edit reject it; stale bulk selection cannot delete history');
  const sale:User={id:users[1],name:'QA',email:prefix+'1@example.com',role:'sale'};
  for(const resource of ['accounts','contacts','tasks','rfqs','quotes','messages'] as const){const context=await readAssistantContext(sale,{resource,query:'',id:({accounts:account,contacts:contact,tasks:task,rfqs:rfq,quotes:quote,messages:message})[resource]});assert.equal(context.data.records?.length,0);}
  await readAssistantContext(sale,{resource:'summary',query:''});
  pass('AI queries and summary respect deleted agencies');
  const duplicate=await api('import',{action:'preview',filename:'qa.csv',records:[{row:2,data:{email}}]});assert.equal(duplicate.duplicates,1);assert.equal(duplicate.records.length,0);
  const newEmail=prefix.toLowerCase()+'-new-import@example.com';
  const imported=await api('import',{filename:'qa.csv',records:[{company:prefix+' Agency',email:newEmail}]});assert.equal(imported.imported,1);
  const [newContact]=await rows('SELECT id,accountId FROM contacts WHERE email=?',[newEmail]);created.contacts.push(newContact.id);created.accounts.push(newContact.accountId);
  assert.notEqual(newContact.accountId,account);assert.equal((await rows('SELECT deletedAt FROM accounts WHERE id=?',[newContact.accountId]))[0].deletedAt,null);
  pass('Reimport never restores deleted profile; new email creates new active agency');
  const blank=await create('accounts',{name:prefix+' Empty'});await run("UPDATE accounts SET name='' WHERE id=?",[blank]);
  const responses=await Promise.all([request('accounts/'+blank,{},'sale','DELETE'),request('accounts/'+blank,{},'sale','DELETE')]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,404]);
  assert.equal((await rows("SELECT COUNT(*) n FROM audit_logs WHERE entityId=? AND action='accounts_deleted'",[blank]))[0].n,1);
  pass('Blank imported profile and concurrent delete work without duplicate audits');
  const adminDelete=await create('accounts',{name:prefix+' Admin deletion'});await api('accounts/'+adminDelete,{},'admin','DELETE');await status('accounts/'+adminDelete,404,undefined,'admin');
  pass('Admin can delete owned-by-sale agency');
  console.log(`Completed ${checks} account deletion checks. No email sent.`);
}finally{
  const drop=async(table:string,column:string,ids:string[])=>{if(ids.length)await run(`DELETE FROM ${table} WHERE ${column} IN (${ids.map(()=>'?').join(',')})`,ids);};
  await drop('campaign_recipients','campaignId',created.campaigns);await drop('campaigns','id',created.campaigns);
  await drop('private_files','actorId',users);await drop('quotes','id',created.quotes);await drop('inbound_messages','id',created.messages);await drop('consent_events','contactId',created.contacts);
  await drop('tasks','id',created.tasks);await drop('rfqs','id',created.rfqs);await drop('contacts','id',created.contacts);await drop('accounts','id',created.accounts);
  await drop('product_versions','productId',created.products);await drop('products','id',created.products);await drop('templates','id',created.templates);await drop('suppressions','id',created.suppressions);
  for(const id of created.rfqs)await run('DELETE FROM settings WHERE settingKey=?',['quote_sequence_'+id]);
  await drop('import_batches','actorId',users);await drop('audit_logs','actorId',users);await drop('notifications','userId',users);await run('DELETE FROM notifications WHERE body LIKE ?',[prefix+'%']);await drop('users','id',users);await pool().end();
}

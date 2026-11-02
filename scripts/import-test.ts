// Dedicated import tests: never invoke cron, campaign dispatch or SMTP.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
import {mapImportRows,suggestImportMapping,sheetImportData} from '../src/lib/import-data';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='IMPORT-QA-'+randomUUID().slice(0,8);
const ids=[randomUUID(),randomUUID()],cookies:string[]=[];
let checks=0;
function pass(name:string){console.log('PASS '+name);checks++;}
async function request(body:unknown,user=0,origin=base){
  return fetch(base+'/api/import',{method:'POST',headers:{Origin:origin,...(cookies[user]?{Cookie:cookies[user]}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});
}
async function api(body:unknown){const response=await request(body),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
async function inspect(text:string,name='file.csv'){
  const form=new FormData();form.set('file',new Blob([text]),name);form.set('inspect','true');
  return fetch(base+'/api/import',{method:'POST',headers:{Origin:base,Cookie:cookies[0]},body:form});
}
try{
  for(const id of ids){
    await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[id,prefix,prefix+id+'@example.com','unused-test-session','sale']);
    const token=randomBytes(32).toString('hex');cookies.push('mailtemp_session='+token);
    await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),id]);
  }
  assert.equal((await request({},99)).status,401);assert.equal((await request({},0,'https://wrong.example')).status,403);
  assert.equal((await request(null)).status,400);assert.equal((await inspect('bad','bad.xlsx')).status,400);
  pass('Authentication, same-origin and invalid-file boundaries');
  const foreignId=randomUUID(),existingId=randomUUID();
  await run('INSERT INTO accounts(id,name,ownerId,region) VALUES (?,?,?,?),(?,?,?,?)',[foreignId,prefix+' Foreign',ids[1],'HCM',existingId,prefix+' Existing',ids[0],'Original']);
  const oldEmail=prefix.toLowerCase()+'old@example.com';
  await run('INSERT INTO contacts(id,accountId,email,source) VALUES (?,?,?,?)',[randomUUID(),existingId,oldEmail,'Original']);
  const email=(i:number)=>prefix.toLowerCase()+i+'@example.com';
  const csv='Giới thiệu dữ liệu\nĐơn vị riêng,Hòm thư,Chức danh,Website,Khu vực,Thị trường,Phân khúc,Nhóm giá,Ghi chú,Cột bỏ\n'+
    Array.from({length:20000},(_,i)=>[i===1?prefix+' Existing':prefix+' Agency '+i,email(i),'Sales','agency.example.com','Hà Nội','Việt Nam','Khách đoàn','VIP','QA note','Ignore me'].join(',')).join('\n');
  const response=await inspect(csv);assert.equal(response.status,200);const file=await response.json();
  const sheet=file.sheets[0],mapping=suggestImportMapping(sheetImportData(sheet,2).headers);mapping['0']='company';mapping['1']='email';
  const mapped=mapImportRows(sheet,2,mapping,'Company-provided QA source');assert.equal(mapped.length,20000);
  assert.equal('Cột bỏ' in mapped[0].data,false);
  const invalidPreview=await api({action:'preview',filename:'errors.csv',records:[
    mapped[0],{row:4,data:mapped[0].data},{row:5,data:{company:'x',email:'bad',source:'x'}},
    {row:6,data:{company:prefix+' Foreign',email:email(30000),source:'x'}},
    {row:7,data:{company:prefix+' Existing',email:oldEmail,source:'x'}},
  ]});
  assert.equal(invalidPreview.records.length,1);assert.equal(invalidPreview.errorTotal,2);
  assert.equal(invalidPreview.duplicates,1);assert.equal(invalidPreview.conflicts,1);assert.equal(invalidPreview.errors[0].row,4);
  pass('Column selection, custom headers, source fallback, duplicate/error/ownership preview');
  assert.equal((await request({action:'preview',filename:'too-many.csv',records:[...mapped,mapped[0]]})).status,400);
  assert.equal((await request({action:'start',id:randomUUID(),filename:'too-many.csv',total:20001})).status,400);
  pass('20,001 rows rejected by server');
  await run('INSERT INTO suppressions(id,email,reason) VALUES (?,?,?)',[randomUUID(),email(0),'manual']);
  const started=performance.now(),preview=await api({action:'preview',filename:prefix+'.csv',records:mapped});assert.equal(preview.records.length,20000);
  const jobId=randomUUID();let job=await api({action:'start',id:jobId,filename:prefix+'.csv',total:20000});
  assert.equal((await request({action:'chunk',id:jobId,index:1,records:preview.records.slice(0,500)})).status,409);
  assert.equal((await request({action:'chunk',id:jobId,index:0,records:preview.records.slice(0,500)},1)).status,404);
  for(let index=0;index<40;index++){
    const records=preview.records.slice(index*500,index*500+500);
    job=await api({action:'chunk',id:jobId,index,records:records.map((record:Record<string,unknown>)=>({...record,consentStatus:'eligible'}))});
    if(index===0){
      const repeated=await api({action:'chunk',id:jobId,index,records});assert.equal(repeated.processed,500);assert.equal(repeated.imported,500);
      assert.equal((await request({action:'chunk',id:jobId,index,records:[{...records[0],name:'Changed'},...records.slice(1)]})).status,409);
      const resume=await api({action:'start',id:jobId,filename:prefix+'.csv',total:20000});assert.equal(resume.nextChunk,1);
    }
  }
  assert.equal(job.processed,20000);assert.equal(job.imported,20000);assert.equal(job.status,'completed');
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.ownerId=?',[ids[0]]))[0].n),20001);
  assert.equal(Number((await rows('SELECT COUNT(*) n FROM import_batches WHERE id=?',[jobId]))[0].n),1);
  pass(`20,000 contacts across 20,000 companies + chunk replay/resume (${((performance.now()-started)/1000).toFixed(1)}s)`);
  const [first]=await rows('SELECT c.*,a.website,a.region,a.market,a.segment,a.tier,a.notes FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE c.email=?',[email(0)]);
  assert.equal(first.consentStatus,'suppressed');assert.equal(first.title,'Sales');assert.equal(first.website,'https://agency.example.com');
  assert.equal(first.tier,'VIP');assert.equal(first.notes,'QA note');assert.equal(first.region,'Hà Nội');
  assert.equal((await rows('SELECT region FROM accounts WHERE id=?',[existingId]))[0].region,'Original');
  assert.equal((await rows('SELECT consentStatus FROM contacts WHERE email=?',[email(1)]))[0].consentStatus,'unreviewed');
  const duplicatePreview=await api({action:'preview',filename:'repeat.csv',records:mapped.slice(0,3)});assert.equal(duplicatePreview.duplicates,3);assert.equal(duplicatePreview.records.length,0);
  const legacy=await api({filename:'legacy.csv',records:[{company:prefix+' Existing',email:email(40000),source:'Legacy',consentStatus:'eligible'}]});assert.equal(legacy.imported,1);
  pass('Expanded fields saved; suppression and ownership preserved; existing company unchanged; legacy compatibility');
  const state=await fetch(base+'/api/state',{headers:{Cookie:cookies[0]}});assert.equal(state.status,200);
  const data=await state.json();assert.equal(data.contacts.length,20002);assert.equal(data.accounts.length,20000);
  pass('Workspace reload handles the full imported dataset');
  const emailOnly=await api({action:'preview',filename:'only-email.csv',records:[
    {row:2,data:{email:email(50000)}},
    {row:3,data:{email:email(50001),company:' ',source:' ',market:'',segment:'',tier:'',country:''}},
    {row:4,data:{email:'bad'}},
  ]});
  assert.equal(emailOnly.records.length,2);assert.equal(emailOnly.errorTotal,1);
  for(const item of emailOnly.records)for(const key of ['company','name','source','market','segment','tier','country'])assert.equal(item[key],'');
  const emailJob=randomUUID();await api({action:'start',id:emailJob,filename:'only-email.csv',total:2});
  const emailSaved=await api({action:'chunk',id:emailJob,index:0,records:emailOnly.records});assert.equal(emailSaved.imported,2);
  const saved=await rows('SELECT c.*,a.name company,a.market,a.segment,a.tier FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE c.email IN (?,?) ORDER BY c.email',[email(50000),email(50001)]);
  assert.equal(saved.length,2);assert.notEqual(saved[0].accountId,saved[1].accountId);
  for(const contact of saved){for(const key of ['company','name','source','market','segment','tier','country'])assert.equal(contact[key],'');assert.equal(contact.consentStatus,'unreviewed');}
  const later=await fetch(base+'/api/contacts/'+saved[0].id+'/details',{method:'PATCH',headers:{Origin:base,Cookie:cookies[0],'Content-Type':'application/json'},body:JSON.stringify({accountId:saved[0].accountId,email:saved[0].email,name:'Added later',source:'',country:''})});assert.equal(later.status,200,await later.text());
  const laterCompany=await fetch(base+'/api/accounts/'+saved[0].accountId+'/details',{method:'PATCH',headers:{Origin:base,Cookie:cookies[0],'Content-Type':'application/json'},body:JSON.stringify({name:prefix+' Added later',market:'',segment:'',tier:'',stage:'new'})});assert.equal(laterCompany.status,200,await laterCompany.text());
  assert.equal((await rows('SELECT name FROM accounts WHERE id=?',[saved[1].accountId]))[0].name,'');
  const emailAgain=await api({action:'preview',filename:'again.csv',records:[{row:2,data:{email:email(50001)}}]});assert.equal(emailAgain.duplicates,1);
  pass('Email-only import saves blank optional fields, isolates unknown companies and supports later edits');
  console.log(`Completed ${checks} import checks. No email sent.`);
}finally{
  for(const id of ids){
    await run('DELETE FROM contacts WHERE accountId IN (SELECT id FROM accounts WHERE ownerId=?)',[id]);
    await run('DELETE FROM accounts WHERE ownerId=?',[id]);
    await run('DELETE FROM import_batches WHERE actorId=?',[id]);
    await run('DELETE FROM audit_logs WHERE actorId=?',[id]);
    await run('DELETE FROM notifications WHERE userId=?',[id]);
    await run('DELETE FROM users WHERE id=?',[id]);
  }
  await run('DELETE FROM suppressions WHERE email LIKE ?',[prefix.toLowerCase()+'%']);
  await pool().end();
}

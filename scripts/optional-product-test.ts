// Fixture-only API/worker checks. Never invokes cron or a mail transport.
// Any manually prepared worker fixture has dueAt in 2099; no schedule API is used.
import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {hash} from '../src/lib/session';
import {claimRecipient,recipientDispatchBlockReason} from '../src/lib/worker';
nextEnv.loadEnvConfig(process.cwd());
const base=process.env.APP_URL||'http://localhost:3000',prefix='OPTIONAL-QA-'+randomUUID().slice(0,8),userId=randomUUID();
const token=randomBytes(32).toString('hex'),cookie='mailtemp_session='+token;
const ids:Record<string,string[]>={accounts:[],contacts:[],products:[],templates:[],campaigns:[]};
let checks=0;
function pass(name:string){console.log('PASS '+(++checks)+' '+name);}
async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST'){return fetch(base+'/api/'+path,{method,headers:{Origin:base,Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function api(path:string,body?:unknown,method?:string){const r=await request(path,body,method),value=await r.json();assert.equal(r.status,200,path+': '+JSON.stringify(value));return value;}
async function create(resource:string,body:unknown){const {id}=await api(resource,body);ids[resource].push(id);return id as string;}
try{
  await run("INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,'fixture-only','sale')",[userId,prefix,prefix.toLowerCase()+'@example.com']);
  await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[hash(token),userId]);
  const accountId=await create('accounts',{name:prefix+' Agency',tier:'Khác'});
  const contactId=await create('contacts',{accountId,email:prefix.toLowerCase()+'-contact@example.com',name:'An',source:'QA explicit signup',country:'VN'});
  const templateId=await create('templates',{name:prefix+' Plain',subject:'Hợp tác cùng {{company_name}}',body:'Chào {{contact_name}}, tôi là {{sender_name}}.'});
  const body={name:prefix+' Campaign',templateId,contactIds:[contactId],followupBody:'Xin chào {{company_name}}',followupDays:4};
  const variants=[{}, {productId:null},{productId:''}],created:string[]=[];
  for(const variant of variants){const id=await create('campaigns',{...body,...variant});created.push(id);const preview=await api('campaigns/'+id);assert.equal(preview.product,null);assert.equal(preview.campaign.productId,null);assert.ok(preview.recipients[0].preview.body.includes('An'));assert.ok(!preview.recipients[0].preview.body.includes('undefined'));}
  const campaignId=created[0];
  const state=await api('state');for(const id of created)assert.ok(state.campaigns.some((row:{id:string})=>row.id===id));
  assert.equal((await api('campaigns')).length,3);
  pass('Create, list and preview campaigns with omitted, null and blank product IDs');
  await api('contacts/'+contactId,{consentStatus:'eligible',consentPurpose:'QA registration for business introduction',consentEvidence:'QA explicit signed registration'},'PATCH');
  assert.equal((await api('campaigns/'+campaignId)).eligible,1);
  // Approval only: these rows have no schedule/dueAt and cannot become cron candidates.
  await api('campaigns/'+campaignId,{action:'approve'},'PATCH');
  const [approved]=await rows('SELECT * FROM campaigns WHERE id=?',[campaignId]);assert.equal(approved.status,'approved');assert.equal(approved.productVersion,null);assert.equal(approved.scheduledAt,null);assert.equal((await rows('SELECT dueAt FROM campaign_recipients WHERE campaignId=?',[campaignId]))[0].dueAt,null);
  await run("UPDATE campaigns SET status='draft',approvedAt=NULL,approvedBy=NULL WHERE id=?",[campaignId]);
  pass('Plain campaign approves without a product; snapshot version remains null and nothing is scheduled');
  const productId=await create('products',{name:prefix+' Tour',destination:'Huế',duration:'3N2Đ',price:2000000,tier:'Khác',validUntil:'2099-12-31',conditions:'QA'});
  await api('campaigns/'+campaignId+'/details',{...body,productId},'PATCH');assert.equal((await api('campaigns/'+campaignId)).product.id,productId);
  await api('campaigns/'+campaignId+'/details',{...body,productId:''},'PATCH');assert.equal((await api('campaigns/'+campaignId)).product,null);
  await api('campaigns/'+created[1]+'/details',{...body,productId:null},'PATCH');
  assert.equal((await request('campaigns',{...body,productId:'bad-id'})).status,400);
  pass('Draft edits can attach or clear a product; malformed IDs remain invalid');
  const priceTemplate=await create('templates',{name:prefix+' Price',subject:'Giá tour',body:'Giá {{price}} cho {{tour_name}}'});
  const priceCampaign=await create('campaigns',{...body,templateId:priceTemplate,followupBody:''});
  assert.match((await api('campaigns/'+priceCampaign)).recipients[0].reason,/chọn chương trình/);
  assert.equal((await request('campaigns/'+priceCampaign,{action:'approve'},'PATCH')).status,409);
  await api('campaigns/'+priceCampaign+'/details',{...body,templateId:priceTemplate,productId,followupBody:''},'PATCH');assert.equal((await api('campaigns/'+priceCampaign)).eligible,1);
  const followupCampaign=await create('campaigns',{...body,followupBody:'Xin nhắc lại giá {{price}}'});assert.match((await api('campaigns/'+followupCampaign)).recipients[0].reason,/chọn chương trình/);assert.equal((await request('campaigns/'+followupCampaign,{action:'approve'},'PATCH')).status,409);
  pass('Product variables in initial mail or follow-up block approval clearly until a product is selected');
  // Prepare an approved snapshot for the real claim/gate functions without running cron/SMTP.
  await run("UPDATE campaigns SET status='scheduled',subject=?,body=?,templateVersion=1,productVersion=NULL,approvedAt=UTC_TIMESTAMP(3),scheduledAt='2099-01-01' WHERE id=?",['Hợp tác {{company_name}}','Chào {{contact_name}}',campaignId]);
  await run("UPDATE campaign_recipients SET dueAt='2099-01-01' WHERE campaignId=?",[campaignId]);
  const recipient=(await rows('SELECT id FROM campaign_recipients WHERE campaignId=?',[campaignId]))[0].id;
  const claim=await claimRecipient(recipient);assert.ok(claim);assert.equal(claim.content.body,'Chào An');
  const [stop]=await rows("SELECT value FROM settings WHERE settingKey='emergency_stop'");
  assert.equal(await recipientDispatchBlockReason(recipient,userId),stop?.value==='true'?'Trạng thái thay đổi trước dispatch':null);
  assert.equal((await rows('SELECT status,sentAt FROM campaign_recipients WHERE id=?',[recipient]))[0].sentAt,null);
  pass('Actual worker claim and pre-dispatch LEFT JOIN handle null product without contacting mail providers');
  await run("UPDATE contacts SET consentStatus='unreviewed' WHERE id=?",[contactId]);assert.match((await recipientDispatchBlockReason(recipient,userId))!,/chứng cứ/);
  await run("UPDATE contacts SET consentStatus='eligible' WHERE id=?",[contactId]);await run('UPDATE templates SET version=version+1 WHERE id=?',[templateId]);assert.equal(await recipientDispatchBlockReason(recipient,userId),'Trạng thái thay đổi trước dispatch');
  await run('UPDATE templates SET version=1 WHERE id=?',[templateId]);
  await run("UPDATE campaign_recipients SET status='pending' WHERE id=?",[recipient]);await run("UPDATE campaigns SET productId=?,productVersion=0 WHERE id=?",[productId,campaignId]);assert.equal(await claimRecipient(recipient),null);assert.equal((await rows('SELECT status FROM campaign_recipients WHERE id=?',[recipient]))[0].status,'skipped');
  pass('Worker retains consent gates and invalidates changed template/product snapshots');
  await run("UPDATE campaigns SET productId=NULL,productVersion=NULL,body='Giá {{price}}' WHERE id=?",[campaignId]);await run("UPDATE campaign_recipients SET status='pending' WHERE id=?",[recipient]);assert.equal(await claimRecipient(recipient),null);assert.match((await rows('SELECT error FROM campaign_recipients WHERE id=?',[recipient]))[0].error,/chọn chương trình/);
  await run("UPDATE campaigns SET body='Chào {{contact_name}}' WHERE id=?",[campaignId]);
  const followupRecipient=randomUUID();await run("INSERT INTO campaign_recipients(id,campaignId,contactId,step,dueAt) VALUES (?,?,?,1,'2099-01-01')",[followupRecipient,campaignId,contactId]);const followup=await claimRecipient(followupRecipient);assert.ok(followup);assert.ok(followup.content.body.includes(prefix+' Agency'));
  assert.equal((await rows("SELECT COUNT(*) n FROM campaign_recipients WHERE campaignId IN (SELECT id FROM campaigns WHERE ownerId=?) AND (sentAt IS NOT NULL OR status='accepted')",[userId]))[0].n,0);
  pass('Worker blocks product variables without a product and renders plain follow-up; zero sent mail');
  console.log(`Completed ${checks} optional product checks. No email sent.`);
}finally{
  const drop=async(table:string,column:string,values:string[])=>{if(values.length)await run(`DELETE FROM ${table} WHERE ${column} IN (${values.map(()=>'?').join(',')})`,values);};
  await drop('campaign_recipients','campaignId',ids.campaigns);await drop('campaigns','id',ids.campaigns);await drop('consent_events','contactId',ids.contacts);await drop('contacts','id',ids.contacts);await drop('accounts','id',ids.accounts);await drop('templates','id',ids.templates);await drop('products','id',ids.products);
  await run('DELETE FROM notifications WHERE userId=? OR body LIKE ?',[userId,prefix+'%']);await run('DELETE FROM audit_logs WHERE actorId=?',[userId]);await run('DELETE FROM users WHERE id=?',[userId]);await pool().end();
}

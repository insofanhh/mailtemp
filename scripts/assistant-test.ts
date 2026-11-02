import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {pool,rows,run} from '../src/lib/db';
import {readAssistantContext} from '../src/lib/assistant-context';
import {draftSchema} from '../src/lib/assistant-schema';
import {saveAssistantDraft} from '../src/lib/assistant-client';
nextEnv.loadEnvConfig(process.cwd());

const base=process.env.APP_URL||'http://localhost:3000',prefix='AIQA-'+randomUUID().slice(0,8),ids={sale:randomUUID(),other:randomUUID(),admin:randomUUID()},cookie:Record<string,string>={},threads:string[]=[],entities:{type:string;id:string}[]=[],notifications:number[]=[];
let checks=0;
const pass=(name:string)=>{console.log('PASS '+name);checks++;};
async function req(path:string,body?:unknown,role='sale',extra:Record<string,string>={}){return fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(cookie[role]?{Cookie:cookie[role]}:{}),'Content-Type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function ok(path:string,body?:unknown,role='sale'){const response=await req(path,body,role),data=await response.json();assert.equal(response.status,200,`${path}: ${JSON.stringify(data)}`);return data;}
async function newThread(role='sale'){const id=randomUUID();threads.push(id);await run('INSERT INTO ai_threads(id,userId,title) VALUES (?,?,?)',[id,ids[role as keyof typeof ids],prefix]);return id;}
async function fixtureDraft(kind:string,data:unknown,role='sale'){
  const threadId=await newThread(role),requestId=randomUUID(),messageId=randomUUID(),id=randomUUID();
  await run("INSERT INTO ai_requests(id,userId,threadId,status) VALUES (?,?,?,'completed')",[requestId,ids[role as keyof typeof ids],threadId]);
  await run("INSERT INTO ai_messages(id,threadId,requestId,role,content) VALUES (?,?,?,'assistant','Bản nháp kiểm thử')",[messageId,threadId,requestId]);
  await run('INSERT INTO ai_drafts(id,userId,messageId,kind,payload) VALUES (?,?,?,?,?)',[id,ids[role as keyof typeof ids],messageId,kind,JSON.stringify(data)]);return {id,threadId,requestId};
}
async function apply(id:string,kind:string,data:unknown,role='sale'){return ok('assistant/actions',{draftId:id,draft:{kind,data},confirmed:true},role);}
try{
  for(const [role,id] of Object.entries(ids)){
    await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[id,prefix+' '+role,prefix+'-'+role+'@example.com','not-a-login-hash',role==='admin'?'admin':'sale']);
    const token=randomBytes(32).toString('hex');await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[createHash('sha256').update(token).digest('hex'),id]);cookie[role]='mailtemp_session='+token;
  }
  assert.equal((await req('assistant',undefined,'none')).status,401);
  assert.equal((await req('assistant',{requestId:randomUUID(),message:'x'},'sale',{Origin:'https://evil.example'})).status,403);
  assert.equal((await req('assistant',{requestId:randomUUID(),message:'x'.repeat(16001)})).status,400);pass('Authentication, CSRF and input size gates');
  const saleThread=await newThread();assert.equal((await req('assistant?threadId='+saleThread,undefined,'other')).status,404);assert.equal((await req('assistant?threadId='+saleThread,undefined,'admin')).status,404);pass('AI conversations remain private to their owner, including from other admins');
  const accountId=randomUUID(),otherAccount=randomUUID();entities.push({type:'accounts',id:accountId},{type:'accounts',id:otherAccount});
  await run('INSERT INTO accounts(id,name,ownerId) VALUES (?,?,?),(?,?,?)',[accountId,prefix+' Own',ids.sale,otherAccount,prefix+' Private',ids.other]);
  const contactId=randomUUID();entities.push({type:'contacts',id:contactId});await run('INSERT INTO contacts(id,accountId,email,source) VALUES (?,?,?,?)',[contactId,accountId,prefix+'@example.com','Test fixture']);
  const user={id:ids.sale,name:prefix,email:prefix+'@example.com',role:'sale' as const};
  const visible=await readAssistantContext(user,{resource:'accounts',query:prefix});assert.equal(visible.sources.length,1);assert.equal(visible.sources[0].id,accountId);
  const hidden=await readAssistantContext(user,{resource:'accounts',query:'',id:otherAccount});assert.equal(hidden.sources.length,0);
  const operations=await readAssistantContext(user,{resource:'operations',query:''});for(const secret of [process.env.DEEPSEEK_API_KEY,process.env.SMTP_PASSWORD,process.env.CRON_SECRET])if(secret)assert.equal(JSON.stringify(operations).includes(secret),false);pass('Model tools enforce sale scope and do not expose infrastructure secrets');
  const template={name:prefix+' Template',subject:'[QC] {{tour_name}}',body:'Chào {{contact_name}}, giá {{price}}. {{conditions}}',category:'QA'};
  const draft=await fixtureDraft('template',template);
  assert.equal((await req('assistant/actions',{draftId:draft.id,draft:{kind:'template',data:template},confirmed:false})).status,400);
  assert.equal((await req('assistant/actions',{draftId:draft.id,draft:{kind:'template',data:template},confirmed:true},'other')).status,404);
  assert.equal((await req('assistant/actions',{draftId:draft.id,draft:{kind:'send_email',data:{}},confirmed:true})).status,400);pass('Draft application requires confirmation, ownership and an allowed action');
  const applied=await apply(draft.id,'template',{...template,name:prefix+' Edited'});entities.push({type:'templates',id:applied.id});
  const again=await apply(draft.id,'template',template);assert.equal(again.id,applied.id);assert.equal(again.alreadyApplied,true);
  assert.equal((await rows('SELECT name FROM templates WHERE id=?',[applied.id]))[0].name,prefix+' Edited');pass('Edited AI template saves once under repeated confirmation');
  const recoveryData={...template,name:prefix+' Recovered'},recoveryDraft=await fixtureDraft('template',recoveryData,'other');let recoveryCalls=0;
  const recovered=await saveAssistantDraft(recoveryDraft.id,{kind:'template',data:recoveryData},async(_url,init)=>{
    recoveryCalls++;const response=await req('assistant/actions',JSON.parse(init!.body as string),'other');
    if(recoveryCalls===1){assert.equal(response.status,200);const saved=await response.json();entities.push({type:'templates',id:saved.id});throw new TypeError('Simulated response lost after database commit');}
    return response;
  });
  assert.equal(recoveryCalls,2);assert.equal(recovered.alreadyApplied,true);assert.equal((await rows('SELECT COUNT(*) n FROM templates WHERE name=?',[recoveryData.name]))[0].n,1);pass('Lost save response retries the real API and recovers exactly one committed template');
  const before=await rows('SELECT COUNT(*) n FROM ai_requests WHERE userId=?',[ids.sale]);
  const cached=await ok('assistant',{requestId:draft.requestId,threadId:draft.threadId,message:'ignored retry',useWorkspace:false});assert.equal(cached.cached,true);
  assert.equal((await rows('SELECT COUNT(*) n FROM ai_requests WHERE userId=?',[ids.sale]))[0].n,before[0].n);pass('Completed request retries are idempotent without a second provider call');
  const task={title:prefix+' Task',accountId:otherAccount,dueAt:'2026-11-04T10:00:00+07:00',priority:'normal'};
  const taskDraft=await fixtureDraft('task',task);assert.equal((await req('assistant/actions',{draftId:taskDraft.id,draft:{kind:'task',data:task},confirmed:true})).status,403);
  const ownTask={...task,accountId};const createdTask=await apply(taskDraft.id,'task',ownTask);entities.push({type:'tasks',id:createdTask.id});
  assert.equal((await rows('SELECT ownerId FROM tasks WHERE id=?',[createdTask.id]))[0].ownerId,ids.sale);pass('Task drafts recheck current account ownership before writing');
  const productId=randomUUID();entities.push({type:'products',id:productId});await run('INSERT INTO products(id,name,destination,duration,validUntil,conditions) VALUES (?,?,?,?,?,?)',[productId,prefix,'Huế','3N2Đ','2099-12-31','QA']);
  const campaign={name:prefix+' Campaign',templateId:applied.id,productId,contactIds:[contactId],followupBody:'',followupDays:4};const campaignDraft=await fixtureDraft('campaign',campaign);const createdCampaign=await apply(campaignDraft.id,'campaign',campaign);entities.push({type:'campaigns',id:createdCampaign.id});
  const [campaignRow]=await rows('SELECT status,approvedAt,scheduledAt FROM campaigns WHERE id=?',[createdCampaign.id]);assert.equal(campaignRow.status,'draft');assert.equal(campaignRow.approvedAt,null);assert.equal(campaignRow.scheduledAt,null);pass('AI campaigns remain unscheduled drafts and cannot grant sending consent');
  const noProductCampaign={...campaign,name:prefix+' No Product',productId:null,recipientPolicy:'include_unreviewed'};const noProductDraft=await fixtureDraft('campaign',noProductCampaign);const noProductSaved=await apply(noProductDraft.id,'campaign',noProductCampaign);entities.push({type:'campaigns',id:noProductSaved.id});assert.equal((await rows('SELECT productId FROM campaigns WHERE id=?',[noProductSaved.id]))[0].productId,null);assert.equal((await rows('SELECT recipientPolicy FROM campaigns WHERE id=?',[noProductSaved.id]))[0].recipientPolicy,'include_unreviewed');pass('AI campaign drafts persist an empty product and explicitly chosen recipient policy');
  if(process.argv.includes('--live')){
    const requestId=randomUUID(),response=await ok('assistant',{requestId,message:'Tạo mẫu email từ thư mẫu này và trả draft template để tôi lưu: Kính gửi Quý đại lý, chúng tôi xin giới thiệu tour miền Trung 3 ngày 2 đêm. Xin liên hệ để nhận bảng giá và điều kiện áp dụng. Trân trọng, Bộ phận kinh doanh. Không dùng dữ liệu hệ thống.',useWorkspace:false,view:'templates'});
    threads.push(response.threadId);const generated=response.messages.at(-1);assert.equal(generated.role,'assistant');assert.ok(generated.drafts?.some((item:{kind:string})=>item.kind==='template'));
    const generatedDraft=generated.drafts.find((item:{kind:string})=>item.kind==='template');draftSchema.parse(generatedDraft);
    assert.equal(generatedDraft.status,'pending');assert.equal((await rows('SELECT entityId FROM ai_drafts WHERE id=?',[generatedDraft.id]))[0].entityId,null);
    const saved=await apply(generatedDraft.id,'template',{...generatedDraft.data,name:prefix+' Live DeepSeek'});entities.push({type:'templates',id:saved.id});pass('LIVE DeepSeek sample email → validated editable template → confirmed library save');
    const scoped=await ok('assistant',{requestId:randomUUID(),message:'Đọc đúng hồ sơ được chọn rồi tóm tắt tên đại lý, trạng thái và bước tiếp theo. Không tạo bản nháp.',useWorkspace:true,view:'accounts',context:{type:'account',id:accountId}});threads.push(scoped.threadId);
    assert.ok(scoped.messages.at(-1).sources.some((source:{id:string})=>source.id===accountId));assert.equal(JSON.stringify(scoped.messages).includes(prefix+' Private'),false);pass('LIVE selected-record context is scoped and attached to the answer');
    const lookup=await ok('assistant',{requestId:randomUUID(),message:`Hãy dùng công cụ tra cứu danh sách đại lý với từ khóa chính xác "${prefix}". Cho biết tên hồ sơ tôi có quyền xem và bước tiếp theo, không tạo bản nháp.`,useWorkspace:true,view:'accounts'});threads.push(lookup.threadId);
    const answer=lookup.messages.at(-1);assert.ok(answer.sources.some((source:{id:string})=>source.id===accountId));assert.equal(JSON.stringify(lookup.messages).includes(prefix+' Private'),false);
    const [trace]=await rows('SELECT metadata FROM ai_messages WHERE id=?',[answer.id]);const metadata=typeof trace.metadata==='string'?JSON.parse(trace.metadata):trace.metadata;assert.ok(metadata.reads.some((read:{resource:string;count:number})=>read.resource==='accounts'&&read.count>0));pass('LIVE model function call searches only authorized agency records');
  }
  const limitedThread=await newThread('other'),limit=Math.max(1,Math.min(300,Number(process.env.AI_DAILY_REQUEST_LIMIT)||60));
  for(let i=0;i<limit;i++)await run("INSERT INTO ai_requests(id,userId,threadId,status) VALUES (?,?,?,'completed')",[randomUUID(),ids.other,limitedThread]);
  assert.equal((await req('assistant',{requestId:randomUUID(),message:'rate limit'},'other')).status,429);pass('Persistent request quota blocks provider calls at the configured limit');
  console.log(`Completed ${checks} assistant checks. No email sent.`);
}finally{
  for(const id of threads)await run('DELETE FROM ai_threads WHERE id=?',[id]);
  for(const type of ['campaigns','tasks','contacts','accounts','templates','products'])for(const entity of entities.filter(e=>e.type===type)){
    if(type==='campaigns')await run('DELETE FROM campaign_recipients WHERE campaignId=?',[entity.id]);
    await run('DELETE FROM '+type+' WHERE id=?',[entity.id]);
  }
  for(const id of Object.values(ids)){await run('DELETE FROM audit_logs WHERE actorId=?',[id]);await run('DELETE FROM notifications WHERE userId=?',[id]);await run('DELETE FROM users WHERE id=?',[id]);}
  for(const id of notifications)await run('DELETE FROM notifications WHERE id=?',[id]);
  await pool().end();
}

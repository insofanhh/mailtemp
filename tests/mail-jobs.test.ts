import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMailJobConsumer,publishRecovery,type MailJob} from '../src/lib/mail-jobs';
import {directPollDelay,refreshDirectViews} from '../src/lib/direct-mail-client';

test('direct jobs process one recipient then durably publish continuation',async()=>{
  const batchId=randomUUID(),events:string[]=[],published:MailJob[]=[];
  const consume=createMailJobConsumer({
    direct:async id=>{assert.equal(id,batchId);events.push('dispatch');return {busy:false,blocked:null};},
    scheduled:async()=>{throw new Error('must not call scheduled gates');},
    pending:async()=>{events.push('pending');return true;},
    publish:async job=>{events.push('publish');published.push(job);},
  });
  await consume({kind:'direct',batchId});
  assert.deepEqual(events,['dispatch','pending','publish']);
  assert.deepEqual(published,[{kind:'direct',batchId}]);
});

test('busy workers retry through the queue; blocked or complete batches do not spin',async()=>{
  for(const state of ['busy','blocked','complete']){
    let publishes=0,pendingCalls=0;
    const consume=createMailJobConsumer({direct:async()=>({busy:state==='busy',blocked:state==='blocked'?'Stopped':null}),scheduled:async()=>{},pending:async()=>{pendingCalls++;return false;},publish:async()=>{publishes++;}});
    if(state==='busy')await assert.rejects(consume({kind:'direct',batchId:randomUUID()}),/DIRECT_WORKER_BUSY/);
    else await consume({kind:'direct',batchId:randomUUID()});
    assert.equal(publishes,0);assert.equal(pendingCalls,state==='complete'?1:0);
  }
});

test('failed continuation publish is retried without bypassing database claims',async()=>{
  const states=['pending','accepted'],attempts:string[]=[];
  const consume=createMailJobConsumer({
    direct:async()=>{attempts.push(states.shift()||'accepted');return {busy:false,blocked:null};},
    scheduled:async()=>{},pending:async()=>true,
    publish:async()=>{if(attempts.length===1)throw new Error('publish unavailable');},
  });
  const job={kind:'direct',batchId:randomUUID()};
  await assert.rejects(consume(job),/publish unavailable/);await consume(job);
  assert.deepEqual(attempts,['pending','accepted']);
});

test('cron publishes recovery and scheduled jobs without calling SMTP',async()=>{
  const batchIds=[randomUUID(),randomUUID()],jobs:{job:MailJob;key?:string}[]=[];
  const result=await publishRecovery(batchIds,async(job,key)=>{jobs.push({job,key});},1234);
  assert.deepEqual(result,{queued:true,directBatches:2,processed:0});
  assert.deepEqual(jobs.map(j=>j.job),[...batchIds.map(batchId=>({kind:'direct',batchId})),{kind:'scheduled'}]);
  assert.equal(jobs[0].key,`recover:${batchIds[0]}:1234`);
  assert.equal(jobs[2].key,'scheduled:1234');
  await assert.rejects(publishRecovery(batchIds,async()=>{throw new Error('unavailable');}),/unavailable/);
});

test('scheduled jobs retain their independent worker and payloads are validated',async()=>{
  let scheduled=0;
  const consume=createMailJobConsumer({direct:async()=>{throw new Error('unexpected');},scheduled:async()=>{scheduled++;},pending:async()=>false,publish:async()=>{}});
  await consume({kind:'scheduled'});assert.equal(scheduled,1);
  for(const invalid of [{kind:'direct',batchId:'bad'},{kind:'direct',batchId:randomUUID(),sendTransport:'fake'},{kind:'other'}])await assert.rejects(consume(invalid));
});

test('read failures after creation remain recoverable and polling backs off',async()=>{
  const warning=await refreshDirectViews([Promise.resolve({id:'committed'}),Promise.reject(new Error('history failed'))]);
  assert.match(warning,/Lượt gửi đã lưu vẫn được xử lý/);
  assert.equal(await refreshDirectViews([Promise.resolve([])]),'');
  assert.equal(directPollDelay(0),2000);assert.equal(directPollDelay(1),4000);assert.equal(directPollDelay(30),30000);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCronHandler} from '../src/lib/cron-handler';

const secret='cron-fixture-secret-at-least-32-characters';
const request=(method:string,authorization?:string,url='https://mailtemp.example/api/cron')=>new Request(url,{method,headers:authorization?{Authorization:authorization}:{}});

test('authenticated GET and POST each execute the same worker once with non-cacheable responses',async()=>{
  let calls=0;
  const handle=createCronHandler(async()=>{calls++;return {processed:0,blocked:null};},()=>secret);
  for(const method of ['GET','POST']){
    const response=await handle(request(method,'Bearer '+secret));
    assert.equal(response.status,200);
    assert.match(response.headers.get('cache-control')!,/no-store/);
    assert.deepEqual(await response.json(),{processed:0,blocked:null});
  }
  assert.equal(calls,2);
});

test('missing or incorrect credentials never execute the worker on either method',async()=>{
  let calls=0;
  const handle=createCronHandler(async()=>{calls++;return {};},()=>secret);
  for(const method of ['GET','POST'])for(const authorization of [undefined,'Bearer incorrect',secret,'Basic '+secret]){
    const response=await handle(request(method,authorization));
    assert.equal(response.status,401);
    assert.match(response.headers.get('cache-control')!,/no-store/);
    assert.deepEqual(await response.json(),{error:'Unauthorized'});
  }
  assert.equal(calls,0);
});

test('query string tokens and missing or short server secrets do not authorize execution',async()=>{
  let calls=0;
  const work=async()=>{calls++;return {};};
  const query=createCronHandler(work,()=>secret);
  assert.equal((await query(request('GET',undefined,'https://mailtemp.example/api/cron?secret='+secret))).status,401);
  for(const value of [undefined,'short'])assert.equal((await createCronHandler(work,()=>value)(request('POST','Bearer '+secret))).status,401);
  assert.equal(calls,0);
});

test('HEAD and unsupported methods never trigger processing even with valid authorization',async()=>{
  let calls=0;
  const handle=createCronHandler(async()=>{calls++;return {};},()=>secret);
  for(const method of ['HEAD','PUT','PATCH','DELETE']){
    const response=await handle(request(method,'Bearer '+secret));
    assert.equal(response.status,405);
    assert.equal(response.headers.get('allow'),'GET, POST');
  }
  assert.equal(calls,0);
});

test('blocked and busy results are preserved without reporting that mail was sent',async()=>{
  for(const result of [{processed:0,blocked:'Ngoài lịch gửi nội bộ'},{busy:true,processed:0}]){
    const response=await createCronHandler(async()=>result,()=>secret)(request('GET','Bearer '+secret));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),result);
  }
});

test('worker failures return a sanitized error without leaking credentials or SQL',async t=>{
  const logs:unknown[][]=[];
  t.mock.method(console,'error',(...args:unknown[])=>{logs.push(args);});
  const detail='private credential and SQL details';
  const handle=createCronHandler(async()=>{throw Object.assign(new Error(detail),{code:'ER_TEST'});},()=>secret);
  const response=await handle(request('POST','Bearer '+secret));
  assert.equal(response.status,500);
  assert.deepEqual(await response.json(),{error:'Cron failed'});
  assert.deepEqual(logs,[['Cron execution failed','ER_TEST']]);
});

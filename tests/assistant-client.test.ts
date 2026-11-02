import test from 'node:test';
import assert from 'node:assert/strict';
import {saveAssistantDraft} from '../src/lib/assistant-client';
import type {AssistantDraft} from '../src/lib/assistant-schema';

const draft:AssistantDraft={kind:'template',data:{name:'Mẫu thử',category:'Giới thiệu tuyến',subject:'{{tour_name}}',body:'Chào {{contact_name}}'}};
const result={id:'saved-template',kind:'template',alreadyApplied:false};

test('Saving retries a network failure with exactly the same confirmed draft',async()=>{
  const calls:{url:unknown;options:RequestInit|undefined}[]=[];
  const request:typeof fetch=async(url,options)=>{calls.push({url,options});if(calls.length===1)throw new TypeError('Failed to fetch');return Response.json(result);};
  assert.deepEqual(await saveAssistantDraft('draft-1',draft,request),result);
  assert.equal(calls.length,2);assert.equal(calls[0].options?.body,calls[1].options?.body);
  assert.deepEqual(JSON.parse(calls[0].options?.body as string),{draftId:'draft-1',draft,confirmed:true});
  assert.equal(calls[1].options?.credentials,'same-origin');
});

test('A lost response after saving is recovered through server idempotency',async()=>{
  let committed=false,calls=0;
  const request:typeof fetch=async()=>{calls++;if(!committed){committed=true;throw new DOMException('Response lost','NetworkError');}return Response.json({...result,alreadyApplied:true});};
  const saved=await saveAssistantDraft('draft-1',draft,request);
  assert.equal(saved.id,result.id);assert.equal(saved.alreadyApplied,true);assert.equal(calls,2);
});

test('Persistent connection failures are bounded and translated to a recoverable message',async()=>{
  let calls=0;
  await assert.rejects(()=>saveAssistantDraft('draft-1',draft,async()=>{calls++;throw new TypeError('Failed to fetch');}),/Bản nháp vẫn được giữ/);
  assert.equal(calls,2);
});

test('An expired session or invalid draft is not retried',async()=>{
  for(const status of [401,400,403]){
    let calls=0;
    await assert.rejects(()=>saveAssistantDraft('draft-1',draft,async()=>{calls++;return Response.json({error:'Dữ liệu không hợp lệ'},{status});}),status===401?/Phiên đăng nhập đã hết hạn/:/Dữ liệu không hợp lệ/);
    assert.equal(calls,1);
  }
});

test('Invalid server responses do not report success or leak parser errors',async()=>{
  await assert.rejects(()=>saveAssistantDraft('draft-1',draft,async()=>new Response('<html>Gateway unavailable</html>',{status:502})),/Máy chủ trả phản hồi không hợp lệ/);
  await assert.rejects(()=>saveAssistantDraft('draft-1',draft,async()=>Response.json({ok:true})),/Chưa xác nhận được kết quả lưu/);
});

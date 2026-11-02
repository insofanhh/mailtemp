import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {classifySmtpFailure,deliveryFailure,sendSmtpMail,SmtpDeliveryError} from '../src/lib/smtp';

type Mode='accept'|'drop_before_data'|'drop_after_data'|'hold_after_data'|'reject_auth'|'reject_after_data';
async function fixture(t:TestContext,mode:Mode='accept',greetingDelay=0){
  const sockets=new Set<Socket>(),timers=new Set<ReturnType<typeof setTimeout>>();
  const stats={dataStarted:0,messages:0,accepted:0};
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    const timer=setTimeout(()=>{timers.delete(timer);if(!socket.destroyed)socket.write('220 fixture.test ESMTP\r\n');},greetingDelay);timers.add(timer);
    let input='',data=false;
    socket.on('data',chunk=>{
      input+=chunk.toString();let newline:number;
      while((newline=input.indexOf('\r\n'))>=0){
        const line=input.slice(0,newline);input=input.slice(newline+2);
        if(data){
          if(line!=='.')continue;
          data=false;stats.messages++;
          if(mode==='drop_after_data'){socket.destroy();return;}
          if(mode==='hold_after_data')continue;
          if(mode==='reject_after_data'){socket.write('554 Message refused\r\n');continue;}
          stats.accepted++;socket.write('250 2.0.0 queued fixture-id\r\n');continue;
        }
        if(/^(EHLO|HELO) /.test(line))socket.write(mode==='reject_auth'?'250-fixture.test\r\n250 AUTH PLAIN\r\n':'250 fixture.test\r\n');
        else if(/^AUTH /.test(line))socket.write('535 Authentication failed\r\n');
        else if(/^MAIL FROM:/.test(line))socket.write('250 Sender accepted\r\n');
        else if(/^RCPT TO:/.test(line)){if(mode==='drop_before_data'){socket.destroy();return;}socket.write('250 Recipient accepted\r\n');}
        else if(line==='DATA'){data=true;stats.dataStarted++;socket.write('354 End with dot\r\n');}
        else if(line==='QUIT')socket.end('221 Bye\r\n');
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address==='object');
  return {stats,options:{host:'127.0.0.1',port:address.port,secure:false,requireTLS:false,...(mode==='reject_auth'?{auth:{user:'fixture',pass:'not-a-real-password'}}:{})}};
}
const message={from:'sender@example.invalid',to:'recipient@example.invalid',subject:'SMTP fixture',text:'Local test only.'};

test('Slow SMTP greeting beyond the former 8 second limit still sends exactly once',async t=>{
  const {options,stats}=await fixture(t,'accept',9000);
  const result=await sendSmtpMail(message,options);
  assert.equal(result.accepted.length,1);assert.equal(stats.messages,1);assert.equal(stats.accepted,1);
});

test('A dropped connection before DATA is failed and does not require reconciliation',async t=>{
  const {options,stats}=await fixture(t,'drop_before_data');
  await assert.rejects(sendSmtpMail(message,options),error=>{
    assert.ok(error instanceof SmtpDeliveryError);assert.equal(error.failure.status,'failed');assert.match(error.message,/chưa được truyền/);return true;
  });
  assert.equal(stats.dataStarted,0);assert.equal(stats.messages,0);
});

test('A dropped connection after the full message remains unknown even if Nodemailer labels it CONN',async t=>{
  const {options,stats}=await fixture(t,'drop_after_data');
  await assert.rejects(sendSmtpMail(message,options),error=>{
    assert.ok(error instanceof SmtpDeliveryError);assert.equal(error.failure.status,'unknown');assert.match(error.message,/DATA/);return true;
  });
  assert.equal(stats.messages,1);assert.equal(stats.accepted,0);
});

test('Authentication failure clearly identifies the sender and never exposes credentials',async t=>{
  const {options,stats}=await fixture(t,'reject_auth');
  await assert.rejects(sendSmtpMail(message,options),error=>{
    assert.ok(error instanceof SmtpDeliveryError);assert.equal(error.failure.status,'failed');assert.match(error.message,/535.*Xác thực tài khoản gửi/);assert.doesNotMatch(error.message,/not-a-real-password|địa chỉ nhận/);return true;
  });
  assert.equal(stats.dataStarted,0);
});

test('An explicit rejection after DATA is failed, not unknown',async t=>{
  const {options,stats}=await fixture(t,'reject_after_data');
  await assert.rejects(sendSmtpMail(message,options),error=>{
    assert.ok(error instanceof SmtpDeliveryError);assert.equal(error.failure.status,'failed');assert.match(error.message,/554/);return true;
  });
  assert.equal(stats.messages,1);
});

test('Deadline before DATA closes the actual socket and prevents any late send',async t=>{
  const {options,stats}=await fixture(t,'accept',200);
  await assert.rejects(sendSmtpMail(message,options,50),error=>{
    assert.ok(error instanceof SmtpDeliveryError);assert.equal(error.failure.status,'failed');assert.match(error.message,/ETIMEDOUT/);return true;
  });
  await new Promise(resolve=>setTimeout(resolve,250));assert.equal(stats.messages,0);
});

test('Deadline waiting for acknowledgement after DATA stays unknown',async t=>{
  const {options,stats}=await fixture(t,'hold_after_data');
  await assert.rejects(sendSmtpMail(message,options,500),error=>{
    assert.ok(error instanceof SmtpDeliveryError);assert.equal(error.failure.status,'unknown');return true;
  });
  assert.equal(stats.messages,1);
});

test('Unclassified errors, including post-send database errors, stay unknown; raw secrets are never saved',()=>{
  assert.equal(deliveryFailure(Object.assign(new Error('database failure'),{responseCode:535})).status,'unknown');
  const secret='password-secret response-token';
  const failure=classifySmtpFailure({code:secret,message:secret,response:secret},'connecting');
  assert.equal(failure.status,'failed');assert.doesNotMatch(failure.message,/password-secret|response-token/);
  assert.equal(classifySmtpFailure({code:'ETIMEDOUT',command:'CONN'},'data').status,'unknown');
});

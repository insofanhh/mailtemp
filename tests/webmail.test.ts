import test from 'node:test';
import assert from 'node:assert/strict';
import {webmailSchema} from '../src/lib/webmail-schema';
import {publicMailAddress,publicMailHost,webmailError} from '../src/lib/webmail-client';
import {webmailEvent} from '../src/lib/webmail';
import {encrypt,decrypt} from '../src/lib/credentials';

test('Webmail accepts SSL IMAP and rejects URLs, plaintext ports and client credential overrides',()=>{
  const valid={email:'sale@example.com',host:'MAIL.EXAMPLE.COM',username:'sale@example.com',password:' secret with spaces '};
  const input=webmailSchema.parse(valid);
  assert.equal(input.host,'mail.example.com');assert.equal(input.port,993);assert.equal(input.password,valid.password);
  for(const extra of [{host:'https://mail.example.com'},{host:'localhost'},{port:143},{port:465},{password:''},{username:'sale\r\nattack'},{userId:'other-user'},{secure:false}])assert.equal(webmailSchema.safeParse({...valid,...extra}).success,false);
});

test('Webmail prevents private destinations, mixed DNS answers and mapped IPv6 bypasses',async()=>{
  for(const address of ['127.0.0.1','10.1.1.1','172.16.4.1','192.168.0.1','169.254.169.254','100.100.100.200','224.0.0.1','0.0.0.0','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::','2001:db8::1'])assert.equal(publicMailAddress(address),false,address);
  assert.equal(publicMailAddress('8.8.8.8'),true);assert.equal(publicMailAddress('2606:4700::1111'),true);
  const resolver=(async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]) as Parameters<typeof publicMailHost>[1];
  await assert.rejects(publicMailHost('mail.example.com',resolver),/WEBMAIL_PRIVATE_HOST/);
});

test('Shared credential encryption round trips OAuth and IMAP secrets and detects tampering',()=>{
  const old=process.env.TOKEN_ENCRYPTION_KEY;process.env.TOKEN_ENCRYPTION_KEY='webmail-test-key-'.repeat(4);
  try{
    const secret='a password / refresh token',encrypted=encrypt(secret);
    assert.equal(decrypt(encrypted),secret);assert.notEqual(encrypt(secret),encrypted);assert.ok(!encrypted.includes(secret));
    const bytes=Buffer.from(encrypted,'base64');bytes[15]^=1;
    assert.throws(()=>decrypt(bytes.toString('base64')));
  }finally{if(old===undefined)delete process.env.TOKEN_ENCRYPTION_KEY;else process.env.TOKEN_ENCRYPTION_KEY=old;}
});

test('Webmail MIME parsing decodes Vietnamese replies, keeps a stable identity and separates auto replies',async()=>{
  const raw=Buffer.from('From: Partner <partner@example.com>\r\nTo: sale@example.com\r\nMessage-ID: <reply-1@example.com>\r\nSubject: =?UTF-8?B?'+Buffer.from('Báo giá Hội An').toString('base64')+'?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from('Chúng tôi cần báo giá đoàn 20 khách.').toString('base64'));
  const date=new Date(),fallback={email:'partner@example.com'};
  const event=await webmailEvent('user-1','sale@example.com','1',3,raw,date,fallback);
  assert.equal(event?.subject,'Báo giá Hội An');assert.match(event?.body||'',/20 khách/);assert.equal(event?.type,'reply');
  assert.equal((await webmailEvent('user-1','sale@example.com','2',99,raw,date,fallback))?.eventId,event?.eventId);
  assert.notEqual((await webmailEvent('user-2','sale@example.com','1',3,raw,date,fallback))?.eventId,event?.eventId);
  const auto=await webmailEvent('user-1','sale@example.com','1',4,Buffer.from('Auto-Submitted: auto-replied\r\nFrom: partner@example.com\r\n\r\nOut of office'),date,fallback);
  assert.equal(auto?.type,'ooo');
  assert.equal(await webmailEvent('user-1','partner@example.com','1',3,raw,date,fallback),null);
});

test('Webmail errors never expose provider authentication responses or passwords',()=>{
  const secret='sensitive-password';
  const message=webmailError({authenticationFailed:true,response:secret,message:secret});
  assert.match(message,/đăng nhập/);assert.ok(!message.includes(secret));
  assert.ok(!webmailError(new Error(secret)).includes(secret));
  assert.match(webmailError({code:'CERT_HAS_EXPIRED'}),/SSL\/TLS/);
});

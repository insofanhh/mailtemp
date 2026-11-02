import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import mysql, {type ConnectionOptions} from 'mysql2';
import {databasePoolOptions} from '../src/lib/db-config';

const host='gateway01.ap-southeast-1.prod.aws.tidbcloud.com';

test('rejects copied placeholder credentials before connecting',()=>{
  assert.throws(()=>databasePoolOptions(`mysql://USERNAME:PASSWORD@${host}:4000/mailtemp`),/vẫn chứa USERNAME\/PASSWORD mẫu/);
});

test('requires the instance prefix on a TiDB Starter gateway',()=>{
  assert.throws(()=>databasePoolOptions(`mysql://root:test-password@${host}:4000/mailtemp`),/thiếu tiền tố/);
});

test('automatically enables verified TLS for TiDB and passes it to mysql2',()=>{
  const options=databasePoolOptions(`mysql://instance.root:test-password@${host}:4000/mailtemp`);
  const pool=mysql.createPool(options);
  try{
    const config=(pool.config as unknown as {connectionConfig:ConnectionOptions}).connectionConfig;
    assert.deepEqual(config.ssl,{rejectUnauthorized:true});
    assert.equal(config.user,'instance.root');
    assert.equal(config.database,'mailtemp');
  }finally{void pool.end();}
});

test('rejects disabled or unverified TLS for TiDB',()=>{
  for(const ssl of ['false','true','null','[]','{"rejectUnauthorized":false}']){
    assert.throws(()=>databasePoolOptions(`mysql://instance.root:test-password@${host}:4000/mailtemp?ssl=${encodeURIComponent(ssl)}`),/TLS/);
  }
});

test('retains local MySQL connections without enabling TLS',()=>{
  const options=databasePoolOptions('mysql://root@127.0.0.1:3306/mailtemp');
  assert.equal(new URL(options.uri!).searchParams.has('ssl'),false);
});

test('validates missing URL, protocol and database without exposing credentials',()=>{
  for(const url of [undefined,'invalid','postgres://user:secret@localhost/mailtemp','mysql://user:secret@localhost/']){
    assert.throws(()=>databasePoolOptions(url),error=>error instanceof Error&&!error.message.includes('secret'));
  }
});

test('migration reports placeholder credentials without connecting or printing a stack trace',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','scripts/migrate.ts'],{
    env:{...process.env,DATABASE_URL:`mysql://USERNAME:PASSWORD@${host}:4000/mailtemp`,ADMIN_PASSWORD:'test-admin-password',MAIL_ENABLED:'false'},encoding:'utf8',timeout:10000
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/vẫn chứa USERNAME\/PASSWORD mẫu/);
  assert.doesNotMatch(result.stderr,/triggerUncaughtException|at .*migrate\.ts/);
  assert.doesNotMatch(result.stdout,/Đã kết nối/);
});

test('migration rejects a short admin password before opening a database connection',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','scripts/migrate.ts'],{
    env:{...process.env,DATABASE_URL:'mysql://test:password-value@127.0.0.1:1/mailtemp',ADMIN_PASSWORD:'too-short',MAIL_ENABLED:'false'},encoding:'utf8',timeout:10000
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/ADMIN_PASSWORD cần ít nhất 12 ký tự/);
  assert.doesNotMatch(result.stderr,/password-value|too-short|ECONNREFUSED/);
  assert.doesNotMatch(result.stdout,/Đã kết nối/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appOrigin,hasTrustedOrigin} from '../src/lib/app-url';

const production='https://mailtemp-ten.vercel.app';
const deployment='https://mailtemp-example-project.vercel.app';
const branch='https://mailtemp-git-main-project.vercel.app';
const platform={VERCEL:'1',VERCEL_PROJECT_PRODUCTION_URL:production.slice(8),VERCEL_URL:deployment.slice(8),VERCEL_BRANCH_URL:branch.slice(8)};
const request=(source?:string,headers:Record<string,string>={})=>new Request(production+'/api/auth/login',{method:'POST',headers:{...(source?{Origin:source}:{}),...headers}});

test('accepts the production, deployment and branch domains supplied by Vercel',()=>{
  for(const source of [production,deployment,branch])assert.equal(hasTrustedOrigin(request(source),platform),true);
});

test('the production domain works even when APP_URL refers to a stale domain',()=>{
  assert.equal(hasTrustedOrigin(request(production),{...platform,APP_URL:'https://old.example.com'}),true);
});

test('missing, malformed and loopback APP_URL use the production URL on Vercel',()=>{
  for(const APP_URL of [undefined,'not-a-url','http://localhost:3000','https://127.0.0.1','https://[::1]','https://dev.localhost']){
    const env={...platform,APP_URL};
    assert.equal(appOrigin(env),production);
    assert.equal(hasTrustedOrigin(request(production),env),true);
    assert.equal(hasTrustedOrigin(request('http://localhost:3000'),env),false);
  }
});

test('preserves an explicit custom domain for links and allows same-origin writes',()=>{
  const env={...platform,APP_URL:'https://mail.example.com/'};
  assert.equal(appOrigin(env),'https://mail.example.com');
  assert.equal(hasTrustedOrigin(request('https://mail.example.com'),env),true);
});

test('does not allow other Vercel projects, suffix lookalikes or malformed Origin headers',()=>{
  for(const source of ['https://attacker.vercel.app','https://mailtemp-ten.vercel.app.attacker.com',production+'/',production+'/path','https://user@mailtemp-ten.vercel.app','http://mailtemp-ten.vercel.app','null',undefined]){
    assert.equal(hasTrustedOrigin(request(source),platform),false,source);
  }
});

test('Host and proxy headers cannot add an attacker origin to the allowlist',()=>{
  assert.equal(hasTrustedOrigin(request('https://attacker.example',{'host':'attacker.example','x-forwarded-host':'attacker.example','x-forwarded-proto':'https'}),platform),false);
});

test('rejects browser requests explicitly marked cross-site even for a trusted source',()=>{
  assert.equal(hasTrustedOrigin(request(production,{'sec-fetch-site':'cross-site'}),platform),false);
  assert.equal(hasTrustedOrigin(request(production,{'sec-fetch-site':'same-origin'}),platform),true);
});

test('local MySQL deployments keep the configured local application origin',()=>{
  const env={APP_URL:'http://localhost:3000'};
  assert.equal(hasTrustedOrigin(request('http://localhost:3000'),env),true);
  assert.equal(hasTrustedOrigin(request(production),env),false);
  assert.equal(appOrigin({}),'http://localhost:3000');
});

test('Vercel domain variables are ignored outside Vercel',()=>{
  const env={...platform,VERCEL:undefined,APP_URL:'http://localhost:3000'};
  assert.equal(hasTrustedOrigin(request(production),env),false);
});

test('invalid configuration fails closed and never trusts the request host',()=>{
  assert.throws(()=>appOrigin({VERCEL:'1',APP_URL:'http://localhost:3000'}),/domain ứng dụng/);
  assert.equal(hasTrustedOrigin(request(production),{VERCEL:'1'}),false);
  assert.equal(hasTrustedOrigin(request(production),{APP_URL:'not-a-url'}),false);
});

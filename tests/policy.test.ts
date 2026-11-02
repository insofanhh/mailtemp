import test from 'node:test';
import assert from 'node:assert/strict';
import {blockReason,insideSendingWindow,interpolate,type PolicyInput} from '../src/lib/policy';
import {consentSchema,importRowSchema} from '../src/lib/schemas';

const ready:PolicyInput={consentStatus:'eligible',evidence:'Khách đăng ký nhận bảng giá',purpose:'Bảng giá tour B2B',country:'VN',suppressed:false,validUntil:'2026-12-31',tier:'Tiêu chuẩn',productTier:'Tiêu chuẩn',source:'Phiếu đăng ký hội chợ',now:new Date('2026-11-02T03:00:00Z')};
test('Website source never grants sending eligibility; review needs evidence',()=>{
  const imported=importRowSchema.parse({company:'Đại lý A',email:'sales@example.com',source:'https://example.com',consentStatus:'eligible'});
  assert.equal('consentStatus' in imported,false);
  assert.match(blockReason({...ready,consentStatus:'unreviewed'})!,/chứng cứ/);
  assert.equal(consentSchema.safeParse({consentStatus:'eligible',consentPurpose:'Bảng giá',consentEvidence:''}).success,false);
});
test('Suppression, stale rates, incorrect tiers and replies block dispatch',()=>{
  assert.equal(blockReason(ready),null);
  for(const change of [{suppressed:true},{validUntil:'2026-11-01'},{tier:'VIP'},{country:'OTHER'},{lastReplyAt:'2026-11-02 03:00:00',approvedAt:'2026-11-02 02:00:00'},{lastContactedAt:'2026-11-02 02:00:00'}])assert.ok(blockReason({...ready,...change}));
});
test('Deleted agencies block dispatch even with valid consent and rates',()=>{
  assert.equal(blockReason({...ready,accountDeletedAt:'2026-11-02 03:00:00'}),'Đại lý đã bị xóa.');
  assert.equal(blockReason({...ready,accountDeletedAt:null}),null);
});
test('Sending windows use Vietnam time at boundaries and on weekends',()=>{
  assert.equal(insideSendingWindow(new Date('2026-11-02T00:59:59Z')),false);
  assert.equal(insideSendingWindow(new Date('2026-11-02T01:00:00Z')),true);
  assert.equal(insideSendingWindow(new Date('2026-11-02T10:00:00Z')),false);
  assert.equal(insideSendingWindow(new Date('2026-11-07T03:00:00Z')),false);
});
test('Campaign may include unreviewed contacts without granting consent or bypassing other checks',()=>{
  const unreviewed={...ready,recipientPolicy:'include_unreviewed',consentStatus:'unreviewed',evidence:'',purpose:''};
  assert.equal(blockReason(unreviewed),null);
  assert.ok(blockReason({...unreviewed,recipientPolicy:'eligible_only'}));
  assert.ok(blockReason({...unreviewed,recipientPolicy:'invalid'}));
  for(const change of [{consentStatus:'needs_evidence'},{consentStatus:'ineligible'},{consentStatus:'suppressed'},{suppressed:true},{consentStatus:'eligible'},{source:''},{country:''},{country:'OTHER'},{validUntil:'2026-01-01'},{tier:'VIP'},{accountDeletedAt:'2026-11-02'},{lastContactedAt:'2026-11-02 02:00:00'}])assert.ok(blockReason({...unreviewed,...change}),JSON.stringify(change));
  assert.equal(unreviewed.consentStatus,'unreviewed');
});
test('Missing personalization cannot leak raw template variables',()=>{
  assert.throws(()=>interpolate('Chào {{ company_name }} · {{ price }}',{company_name:'A'}),/price/);
  assert.equal(interpolate('Chào {{ company_name }}',{company_name:'Đại lý A'}),'Chào Đại lý A');
});

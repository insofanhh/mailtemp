import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignSchema} from '../src/lib/schemas';
import {draftSchema} from '../src/lib/assistant-schema';
import {renderMail} from '../src/lib/mail';
import {blockReason,type PolicyInput} from '../src/lib/policy';

const campaign={name:'Giới thiệu hợp tác',templateId:'9a7496bb-fd1f-42a6-9621-298f351187d0',contactIds:['35172ddc-67ba-4019-9cb1-8be729e2ecf4']};
test('Campaigns and AI drafts accept omitted, blank or null products while rejecting malformed IDs',()=>{
  for(const data of [campaign,{...campaign,productId:''},{...campaign,productId:null}]){
    assert.equal(campaignSchema.parse(data).productId,null);
    assert.equal(draftSchema.parse({kind:'campaign',data}).kind,'campaign');
  }
  assert.equal(campaignSchema.parse({...campaign,productId:campaign.templateId}).productId,campaign.templateId);
  assert.equal(campaignSchema.safeParse({...campaign,productId:'not-a-product'}).success,false);
});
test('Plain email renders without a product and never inserts undefined values',()=>{
  assert.deepEqual(renderMail('Hợp tác cùng {{ company_name }}','Chào {{ contact_name }}, tôi là {{ sender_name }}.',{accountName:'Đại lý A',name:'An'},null,'Bình'),{subject:'[QC] Hợp tác cùng Đại lý A',body:'Chào An, tôi là Bình.'});
});
test('Product variables in subject, body or follow-up require a product',()=>{
  for(const variable of ['tour_name','duration','price','unit','valid_until','conditions']){
    assert.throws(()=>renderMail('{{ '+variable+' }}','Nội dung',{accountName:'A'},null,'Sale'),/chọn chương trình/);
    assert.throws(()=>renderMail('Chào đại lý','{{ '+variable+' }}',{accountName:'A'},null,'Sale'),/chọn chương trình/);
  }
  const mail=renderMail('{{tour_name}}','{{duration}} · {{price}}/{{unit}} · {{valid_until}} · {{conditions}}',{accountName:'A'},{name:'Huế',duration:'3N2Đ',price:2000000,currency:'VND',unit:'khách',validUntil:'2099-12-31',conditions:'Theo thỏa thuận'},'Sale');
  assert.equal(mail.subject,'[QC] Huế');assert.ok(mail.body.includes('2.000.000 VND/khách'));
});
test('No-product campaigns still enforce consent, source, market, suppression, reply and template history',()=>{
  const ready:PolicyInput={hasProduct:false,consentStatus:'eligible',evidence:'Đăng ký nhận tin',purpose:'Hợp tác du lịch',country:'VN',suppressed:false,source:'Phiếu đăng ký',validUntil:'',tier:'Khác',productTier:'',now:new Date('2026-11-02T03:00:00Z')};
  assert.equal(blockReason(ready),null);
  for(const change of [{consentStatus:'unreviewed'},{evidence:''},{purpose:''},{source:''},{country:'OTHER'},{suppressed:true},{accountDeletedAt:'2026-11-02 02:00:00'},{lastReplyAt:'2026-11-02 02:00:00',approvedAt:'2026-11-02 01:00:00'}])assert.ok(blockReason({...ready,...change}));
  assert.match(blockReason({...ready,hasProduct:true,validUntil:'2026-11-01'})!,/hết hiệu lực/);
  assert.match(blockReason({...ready,hasProduct:true,validUntil:'2099-12-31'})!,/nhóm đại lý/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {templateIdentity,templateHistoryReason,TEMPLATE_ALREADY_SENT} from '../src/lib/template-history';
import {directMailSchema} from '../src/lib/direct-mail-schema';
import {campaignSchema} from '../src/lib/schemas';
import {blockReason} from '../src/lib/policy';

test('named templates keep their identity across edits; different templates are independent',()=>{
  const id=randomUUID(),a=templateIdentity('Hello','Body',id),edited=templateIdentity('New subject','Changed body',id);
  assert.equal(a.templateKey,edited.templateKey);assert.notEqual(a.contentKey,edited.contentKey);
  assert.notEqual(a.templateKey,templateIdentity('Hello','Body',randomUUID()).templateKey);
});
test('ad hoc messages match canonical subject/body and follow-up has a separate identity',()=>{
  assert.equal(templateIdentity(' Hello ','Line 1\r\nLine 2 ').templateKey,templateIdentity('Hello','Line 1\nLine 2').templateKey);
  const id=randomUUID();assert.notEqual(templateIdentity('Hello','Body',id).templateKey,templateIdentity('Hello','Body',id,1).templateKey);
});
test('resend mode only lifts accepted-template restrictions, never unresolved delivery',()=>{
  assert.equal(templateHistoryReason('accepted'),TEMPLATE_ALREADY_SENT);
  assert.equal(templateHistoryReason('accepted',true),null);
  assert.equal(templateHistoryReason(undefined),null);
  for(const status of ['sending','unknown'])assert.ok(templateHistoryReason(status,true));
});
test('resending is opt in per batch and campaign; string false never enables it',()=>{
  const input={name:'QA',subject:'Hello',body:'Body',contactIds:[randomUUID()]};
  assert.equal(directMailSchema.parse(input).allowTemplateResend,false);
  assert.equal(directMailSchema.parse(input).templateId,null);
  assert.equal(directMailSchema.safeParse({...input,allowTemplateResend:'false'}).success,false);
  for(const value of [undefined,false,'false'])assert.equal(campaignSchema.parse({...input,templateId:randomUUID(),allowTemplateResend:value}).allowTemplateResend,false);
});
test('a recent contact no longer imposes a blanket 24-hour wait',()=>{
  assert.equal(blockReason({hasProduct:false,consentStatus:'unreviewed',recipientPolicy:'include_unreviewed',source:'Website',country:'VN',suppressed:false,validUntil:'',tier:'',productTier:'',lastContactedAt:new Date().toISOString().slice(0,23).replace('T',' ')}),null);
});

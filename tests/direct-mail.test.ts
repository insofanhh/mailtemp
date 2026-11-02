import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {directMailSchema,directStartSchema} from '../src/lib/direct-mail-schema';
const input={name:'Chào giá',subject:'Hợp tác',body:'Kính gửi đại lý',contactIds:[randomUUID()]};
test('Direct mail accepts an email body without a business address, product, schedule or inbox sync settings',()=>{
  const result=directMailSchema.parse(input);
  assert.equal(result.productId,null);assert.equal(result.recipientPolicy,'include_unreviewed');
  assert.equal('sender_address' in result,false);assert.equal('scheduledAt' in result,false);
});
test('Direct mail bounds recipients, removes duplicate IDs, and rejects header injection and privileged client flags',()=>{
  assert.equal(directMailSchema.parse({...input,contactIds:[...input.contactIds,...input.contactIds]}).contactIds.length,1);
  for(const patch of [{subject:'Hi\r\nBcc: other@example.com'},{contactIds:[]},{contactIds:Array.from({length:1001},()=>randomUUID())},{body:''},{ownerId:'bad-id'}])assert.equal(directMailSchema.safeParse({...input,...patch}).success,false);
  const parsed=directMailSchema.parse({...input,ignoreSuppressions:true,testMode:true,sendTransport:'fake'});
  assert.equal('ignoreSuppressions' in parsed,false);assert.equal('testMode' in parsed,false);
  assert.equal(directStartSchema.safeParse({input,requestId:randomUUID(),previewToken:'short'}).success,false);
});

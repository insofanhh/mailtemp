import {randomUUID} from 'node:crypto';
import {rows,run,sqlDate,transaction} from './db';
import {HttpError,ownAccount} from './auth';
import type {User} from './session';
import {draftSchema} from './assistant-schema';
import {audit,notify} from './activity';

export async function applyAssistantDraft(user:User,id:string,payload:unknown){
  const draft=draftSchema.parse(payload);
  return transaction(async db=>{
    const [saved]=await rows('SELECT * FROM ai_drafts WHERE id=? AND userId=? FOR UPDATE',[id,user.id],db);
    if(!saved)throw new HttpError(404,'Không tìm thấy bản nháp của bạn.');
    if(saved.kind!==draft.kind)throw new HttpError(400,'Loại bản nháp không khớp.');
    if(saved.status==='applied')return {id:saved.entityId,kind:saved.kind,alreadyApplied:true};
    if(draft.kind==='reply')throw new HttpError(400,'Bản trả lời dùng để sao chép sang hộp thư, không tự gửi.');
    const entityId=randomUUID();
    if(draft.kind==='template'){
      const data=draft.data;
      await run('INSERT INTO templates(id,name,subject,body,category) VALUES (?,?,?,?,?)',[entityId,data.name,data.subject,data.body,data.category],db);
    }else if(draft.kind==='task'){
      const data=draft.data;let ownerId=user.id;
      if(data.accountId){await rows('SELECT id FROM accounts WHERE id=? FOR UPDATE',[data.accountId],db);ownerId=(await ownAccount(user,data.accountId,db)).ownerId;}
      if(data.ownerId&&data.ownerId!==ownerId)throw new HttpError(409,'Công việc cần giao đúng người phụ trách.');
      await run('INSERT INTO tasks(id,title,accountId,ownerId,dueAt,priority) VALUES (?,?,?,?,?,?)',[entityId,data.title,data.accountId||null,ownerId,sqlDate(data.dueAt),data.priority],db);
    }else if(draft.kind==='rfq'){
      const data=draft.data;await rows('SELECT id FROM accounts WHERE id=? FOR UPDATE',[data.accountId],db);const account=await ownAccount(user,data.accountId,db);
      await run('INSERT INTO rfqs(id,accountId,ownerId,title,destination,departureDate,pax,budget,deadline,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',[entityId,data.accountId,account.ownerId,data.title,data.destination,data.departureDate||null,data.pax,data.budget,data.deadline||null,data.notes],db);
      await run("UPDATE accounts SET stage='rfq' WHERE id=? AND stage NOT IN ('won','lost','quoted')",[data.accountId],db);
    }else if(draft.kind==='quote'){
      const data=draft.data,[rfq]=await rows('SELECT * FROM rfqs WHERE id=? FOR UPDATE',[data.rfqId],db);if(!rfq)throw new HttpError(404,'Không có RFQ.');await rows('SELECT id FROM accounts WHERE id=? FOR UPDATE',[rfq.accountId],db);await ownAccount(user,rfq.accountId,db);
      if(['won','lost'].includes(rfq.status))throw new HttpError(409,'RFQ đã đóng. Hãy kiểm tra lại trước khi thêm báo giá.');
      const [latest]=await rows('SELECT COALESCE(MAX(version),0)+1 version FROM quotes WHERE rfqId=?',[data.rfqId],db);
      await run('INSERT INTO quotes(id,rfqId,version,amount,currency,validUntil,conditions) VALUES (?,?,?,?,?,?,?)',[entityId,data.rfqId,latest.version,data.amount,data.currency,data.validUntil,data.conditions],db);
      await run("UPDATE rfqs SET status='quoted' WHERE id=?",[data.rfqId],db);
    }else if(draft.kind==='campaign'){
      const data=draft.data,unique=[...new Set(data.contactIds)],contacts=await rows(`SELECT c.id,c.accountId,a.ownerId FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.deletedAt IS NULL AND c.id IN (${unique.map(()=>'?').join(',')}) ORDER BY a.id FOR UPDATE`,unique,db);
      if(contacts.length!==unique.length)throw new HttpError(409,'Danh sách người nhận không còn hợp lệ.');
      const ownerId=contacts[0].ownerId;
      if(contacts.some(c=>c.ownerId!==ownerId)||(user.role!=='admin'&&ownerId!==user.id)||(data.ownerId&&data.ownerId!==ownerId))throw new HttpError(403,'Chiến dịch cần cùng sale phụ trách và thuộc phạm vi quyền.');
      if(new Set(contacts.map(c=>c.accountId)).size!==contacts.length)throw new HttpError(409,'Chỉ chọn một người liên hệ mỗi đại lý.');
      const [template]=await rows('SELECT id FROM templates WHERE id=?',[data.templateId],db),[product]=data.productId?await rows('SELECT id FROM products WHERE id=?',[data.productId],db):[];
      if(!template||(data.productId&&!product))throw new HttpError(409,'Tour hoặc mẫu thư không còn tồn tại.');
      const [conflict]=await rows(`SELECT r.id FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId JOIN contacts c ON c.id=r.contactId WHERE c.accountId IN (${contacts.map(()=>'?').join(',')}) AND (r.status IN ('sending','unknown') OR (r.status='pending' AND p.status IN ('approved','scheduled','running','paused'))) LIMIT 1`,contacts.map(c=>c.accountId),db);
      if(conflict)throw new HttpError(409,'Đại lý đang có lượt gửi hoạt động hoặc cần đối soát.');
      await run('INSERT INTO campaigns(id,name,ownerId,templateId,productId,recipientPolicy,allowTemplateResend,followupBody,followupDays) VALUES (?,?,?,?,?,?,?,?,?)',[entityId,data.name,ownerId,data.templateId,data.productId,data.recipientPolicy,data.allowTemplateResend,data.followupBody,data.followupDays],db);
      for(const contactId of unique)await run('INSERT INTO campaign_recipients(id,campaignId,contactId) VALUES (?,?,?)',[randomUUID(),entityId,contactId],db);
    }
    await run("UPDATE ai_drafts SET status='applied',entityId=?,payload=?,appliedAt=UTC_TIMESTAMP(3) WHERE id=?",[entityId,JSON.stringify(draft.data),id],db);
    await audit(user.id,'ai_draft_applied',draft.kind,entityId,{draftId:id},db);
    await notify(user.id,'Đã lưu bản nháp từ trợ lý',draft.kind==='template'?draft.data.name:'Bản ghi đã được tạo sau khi bạn xác nhận.','success',db);
    return {id:entityId,kind:draft.kind,alreadyApplied:false};
  });
}

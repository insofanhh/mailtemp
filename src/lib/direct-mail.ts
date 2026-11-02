import {createHash,randomUUID} from 'node:crypto';
import {rows,run,transaction,pool,type DB} from './db';
import {HttpError,type User} from './auth';
import {audit,notify} from './activity';
import {blockReason,normalizeEmail} from './policy';
import {renderMail,mailReady,messageContent,sendSmtpMail} from './mail';
import {deliveryFailure} from './smtp';
import {sendOAuth} from './oauth';
import type {DirectMailInput} from './direct-mail-schema';
import {DIRECT_ACTIVE_SQL,type MailConflict} from './direct-mail-conflicts';
import {appOrigin} from './app-url';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DIRECT_QUEUE_LOCK='mailtemp_direct_queue';
export async function directBatch(user:User,id:string,db?:DB,lock=false){
  const [batch]=await rows('SELECT * FROM direct_mail_batches WHERE id=?'+(lock?' FOR UPDATE':''),[id],db);
  if(!batch)throw new HttpError(404,'Không tìm thấy lượt gửi trực tiếp.');
  if(user.role!=='admin'&&batch.ownerId!==user.id)throw new HttpError(403,'Lượt gửi thuộc sale khác.');
  return batch;
}
async function sendingGate(ownerId:string,db?:DB){
  const [stop]=await rows("SELECT value FROM settings WHERE settingKey='emergency_stop'",[],db);
  if(stop?.value==='true')return 'Hệ thống đang dừng khẩn cấp. Tắt dừng khẩn cấp để tiếp tục.';
  if(process.env.MAIL_ENABLED!=='true')return 'Dịch vụ gửi chưa bật (MAIL_ENABLED).';
  const [mailbox]=await rows('SELECT provider FROM mailboxes WHERE userId=?',[ownerId],db);
  if(!mailbox&&!mailReady())return 'Chưa cấu hình SMTP hoặc kết nối hộp thư gửi.';
  return null;
}
async function contactsFor(ids:string[],db?:DB,excludeBatch:string|null=null){
  return rows(`SELECT c.*,a.name accountName,a.tier,a.ownerId,a.deletedAt accountDeletedAt,(SELECT active FROM users WHERE id=a.ownerId) ownerActive,
    EXISTS(SELECT 1 FROM suppressions s WHERE s.email=c.email) suppressed,
    EXISTS(SELECT 1 FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId JOIN contacts c2 ON c2.id=r.contactId WHERE c2.email=c.email AND (r.status IN ('sending','unknown') OR (r.status='pending' AND p.status IN ('approved','scheduled','running','paused')))) campaignConflict,
    EXISTS(SELECT 1 FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE r.email=c.email AND (? IS NULL OR b.id<>?) AND ${DIRECT_ACTIVE_SQL}) directConflict
    FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE c.id IN (${ids.map(()=>'?').join(',')}) ORDER BY c.id`,[excludeBatch,excludeBatch,...ids],db);
}
function contactReason(contact:Record<string,string|number|null>,input:DirectMailInput,product:Record<string,string|number>|null){
  if(!contact.ownerActive)return 'Sale gửi đã ngừng hoạt động.';
  if(contact.ownerId!==input.ownerId)return 'Liên hệ thuộc sale khác.';
  if(contact.campaignConflict)return 'Email này đang có lượt gửi trong chiến dịch khác. Xem lượt đang chặn để xử lý.';
  if(contact.directConflict)return 'Email này đang có lượt gửi trực tiếp hoạt động hoặc cần đối soát. Xem lượt đang chặn để xử lý.';
  return blockReason({recipientPolicy:input.recipientPolicy,hasProduct:!!product,accountDeletedAt:contact.accountDeletedAt as string|null,consentStatus:String(contact.consentStatus),evidence:contact.consentEvidence as string|null,purpose:contact.consentPurpose as string|null,country:String(contact.country),suppressed:!!contact.suppressed,source:String(contact.source||''),validUntil:String(product?.validUntil||''),tier:String(contact.tier),productTier:String(product?.tier||''),lastContactedAt:contact.lastContactedAt as string|null});
}
export async function previewDirectMail(user:User,input:DirectMailInput,db?:DB){
  const ownerId=user.role==='admin'?(input.ownerId||user.id):user.id;
  if(user.role!=='admin'&&input.ownerId&&input.ownerId!==user.id)throw new HttpError(403,'Không thể gửi thay sale khác.');
  const [sender]=await rows('SELECT id,name,active FROM users WHERE id=?',[ownerId],db);
  if(!sender?.active)throw new HttpError(409,'Sale gửi không còn hoạt động.');
  const product=input.productId?(await rows('SELECT * FROM products WHERE id=?',[input.productId],db))[0]||null:null;
  if(input.productId&&!product)throw new HttpError(409,'Chương trình / bảng giá không còn tồn tại.');
  const contacts=await contactsFor(input.contactIds,db);
  if(contacts.length!==input.contactIds.length)throw new HttpError(409,'Một số liên hệ không còn tồn tại. Hãy chọn lại danh sách.');
  if(user.role!=='admin'&&contacts.some(c=>c.ownerId!==user.id))throw new HttpError(403,'Danh sách có liên hệ thuộc sale khác.');
  const emails=contacts.map(c=>normalizeEmail(c.email)),marks=emails.map(()=>'?').join(',');
  const conflicts=await rows(`SELECT 'direct' kind,b.id batchId,b.name batchName,b.ownerId,r.email,r.status FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE r.email IN (${marks}) AND ${DIRECT_ACTIVE_SQL}
    UNION ALL SELECT 'campaign' kind,p.id batchId,p.name batchName,p.ownerId,c.email,r.status FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId JOIN contacts c ON c.id=r.contactId WHERE c.email IN (${marks}) AND (r.status IN ('sending','unknown') OR (r.status='pending' AND p.status IN ('approved','scheduled','running','paused'))) ORDER BY batchId`,[...emails,...emails],db);
  const grants=await rows(`SELECT r.id,r.email FROM direct_mail_recipients r WHERE r.email IN (${marks}) AND r.status='unknown' AND r.retryAuthorizedAt IS NOT NULL AND r.retryConsumedBy IS NULL ORDER BY r.id`,emails,db);
  const recipients=contacts.map(c=>{
    let reason=contactReason(c,{...input,ownerId},product),preview:null|{subject:string;body:string}=null;
    try{preview=renderMail(input.subject,input.body,c,product,sender.name);}catch(e){reason=(e as Error).message;}
    const blockers:MailConflict[]=conflicts.filter(r=>normalizeEmail(r.email)===normalizeEmail(c.email)).map(r=>{const canManage=user.role==='admin'||r.ownerId===user.id;return {kind:r.kind,batchId:canManage?r.batchId:null,batchName:canManage?r.batchName:'Lượt gửi của sale khác',email:r.email,status:r.status,canManage};});
    return {id:c.id,email:c.email,name:c.name,accountName:c.accountName,consentStatus:c.consentStatus,reason,preview,conflicts:blockers,retryAuthorizationIds:grants.filter(r=>normalizeEmail(r.email)===normalizeEmail(c.email)).map(r=>r.id)};
  });
  const gate=await sendingGate(ownerId,db);
  const [box]=await rows('SELECT provider,email FROM mailboxes WHERE userId=?',[ownerId],db);
  const transport=box?box.provider+' · '+box.email:'SMTP · '+(process.env.SMTP_FROM_EMAIL||'chưa cấu hình');
  const eligible=recipients.filter(r=>!r.reason).length;
  return {recipients,eligible,blocked:recipients.length-eligible,retryCount:recipients.filter(r=>!r.reason&&r.retryAuthorizationIds.length).length,gate,transport,ownerId,product,senderName:sender.name,
    previewToken:digest({input,ownerId,senderName:sender.name,product,recipients,gate,transport})};
}
export async function startDirectMail(user:User,input:DirectMailInput,requestId:string,previewToken:string,acceptExclusions:boolean,acceptDuplicateRisk=false){
  const ownerId=user.role==='admin'?(input.ownerId||user.id):user.id,payloadHash=digest({...input,ownerId,acceptDuplicateRisk});
  const existing=async(db?:DB)=>{
    const [batch]=await rows('SELECT id,payloadHash FROM direct_mail_batches WHERE ownerId=? AND requestId=?',[ownerId,requestId],db);
    if(!batch)return null;
    if(batch.payloadHash!==payloadHash)throw new HttpError(409,'Mã xác nhận đã dùng cho nội dung khác. Hãy kiểm tra lại.');
    return {id:batch.id,alreadyStarted:true};
  };
  if(user.role!=='admin'&&input.ownerId&&input.ownerId!==user.id)throw new HttpError(403,'Không có quyền gửi thay sale khác.');
  const prior=await existing();if(prior)return prior;
  try{return await transaction(async db=>{
    await rows(`SELECT a.id FROM accounts a JOIN contacts c ON c.accountId=a.id WHERE c.id IN (${input.contactIds.map(()=>'?').join(',')}) ORDER BY a.id FOR UPDATE`,input.contactIds,db);
    if(input.productId)await rows('SELECT id FROM products WHERE id=? FOR UPDATE',[input.productId],db);
    const repeat=await existing(db);if(repeat)return repeat;
    const preview=await previewDirectMail(user,input,db);
    if(preview.previewToken!==previewToken)throw new HttpError(409,'Nội dung hoặc danh sách đã thay đổi. Hãy kiểm tra lại trước khi gửi.');
    if(preview.gate)throw new HttpError(409,preview.gate);
    if(!preview.eligible)throw new HttpError(409,'Không có người nhận đạt điều kiện để gửi.');
    if(preview.blocked&&!acceptExclusions)throw new HttpError(409,'Xác nhận bỏ qua danh sách không đạt trước khi gửi.');
    if(preview.retryCount&&!acceptDuplicateRisk)throw new HttpError(409,'Cần xác nhận nguy cơ nhận trùng khi sử dụng quyền gửi lại.');
    const id=randomUUID();
    await run('INSERT INTO direct_mail_batches(id,ownerId,requestId,payloadHash,name,subject,body,recipientPolicy,productSnapshot,senderName,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',[id,ownerId,requestId,payloadHash,input.name,input.subject,input.body,input.recipientPolicy,preview.product?JSON.stringify(preview.product):null,preview.senderName],db);
    for(const r of preview.recipients){
      const recipientId=randomUUID();
      await run('INSERT INTO direct_mail_recipients(id,batchId,contactId,email,accountName,status,error) VALUES (?,?,?,?,?,?,?)',[recipientId,id,r.id,normalizeEmail(r.email),r.accountName,r.reason?'skipped':'pending',r.reason],db);
      if(!r.reason)for(const grantId of r.retryAuthorizationIds){
        const consumed=await run("UPDATE direct_mail_recipients SET retryConsumedBy=? WHERE id=? AND status='unknown' AND retryAuthorizedAt IS NOT NULL AND retryConsumedBy IS NULL",[recipientId,grantId],db);
        if(consumed.affectedRows!==1)throw new HttpError(409,'Quyền gửi lại đã thay đổi hoặc được sử dụng. Hãy kiểm tra lại.');
      }
    }
    await audit(user.id,'direct_mail_started','direct_mail',id,{eligible:preview.eligible,excluded:preview.blocked,recipientPolicy:input.recipientPolicy},db);
    await notify(ownerId,'Đã bắt đầu gửi trực tiếp',input.name,'info',db);
    return {id,alreadyStarted:false};
  });}catch(e){if((e as {code?:string}).code==='ER_DUP_ENTRY'){const duplicate=await existing();if(duplicate)return duplicate;}throw e;}
}
export async function directMailDetails(user:User,id:string){
  const batch=await directBatch(user,id);
  const recipients=await rows('SELECT id,email,accountName,status,attempts,error,messageId,claimedAt,sentAt,renderedSubject,retryAuthorizedAt,retryAuthorizedBy,retryReason,retryConsumedBy FROM direct_mail_recipients WHERE batchId=? ORDER BY email',[id]);
  const gate=await sendingGate(batch.ownerId);
  return {batch,recipients,gate};
}
export async function directMailList(user:User){
  return rows(`SELECT b.id,b.ownerId,b.name,b.status,b.createdAt,b.finishedAt,u.name ownerName,COUNT(r.id) total,
    SUM(r.status='accepted') accepted,SUM(r.status='pending') pending,SUM(r.status='sending') sending,
    SUM(r.status='skipped') skipped,SUM(r.status='failed') failed,SUM(r.status='unknown') unknownCount
    FROM direct_mail_batches b JOIN users u ON u.id=b.ownerId LEFT JOIN direct_mail_recipients r ON r.batchId=b.id ${user.role==='admin'?'':'WHERE b.ownerId=?'} GROUP BY b.id ORDER BY b.createdAt DESC LIMIT 100`,user.role==='admin'?[]:[user.id]);
}
export async function controlDirectMail(user:User,id:string,action:'pause'|'resume'|'cancel'){
  await transaction(async db=>{
    const batch=await directBatch(user,id,db,true);
    if(!['queued','running','paused'].includes(batch.status))throw new HttpError(409,'Lượt gửi đã kết thúc.');
    const status=action==='pause'?'paused':action==='resume'?'queued':'cancelled';
    await run("UPDATE direct_mail_batches SET status=?,finishedAt=IF(?='cancelled',UTC_TIMESTAMP(3),finishedAt) WHERE id=?",[status,status,id],db);
    if(action==='cancel')await run("UPDATE direct_mail_recipients SET status='skipped',error='Người gửi đã dừng lượt gửi trực tiếp.' WHERE batchId=? AND status='pending'",[id],db);
    await audit(user.id,'direct_mail_'+action,'direct_mail',id,{},db);await notify(batch.ownerId,'Đã cập nhật lượt gửi trực tiếp',batch.name,'info',db);
  });
}
async function refreshReviewStatus(id:string,db:DB){
  await run("UPDATE direct_mail_batches b SET status=IF(EXISTS(SELECT 1 FROM direct_mail_recipients r WHERE r.batchId=b.id AND r.status='unknown' AND r.retryAuthorizedAt IS NULL),'needs_review',IF(EXISTS(SELECT 1 FROM direct_mail_recipients r WHERE r.batchId=b.id AND r.status='unknown'),'review_released','completed')) WHERE b.id=? AND b.status IN ('needs_review','review_released','completed')",[id],db);
}
export async function authorizeDirectRetry(user:User,id:string,recipientId:string,reason:string){
  if(user.role!=='admin')throw new HttpError(403,'Chỉ quản trị viên được cho phép gửi lại.');
  if(reason.trim().length<20||reason.length>2000)throw new HttpError(400,'Cần lý do gửi lại từ 20 đến 2.000 ký tự.');
  await transaction(async db=>{
    const batch=await directBatch(user,id,db,true);
    const [recipient]=await rows('SELECT * FROM direct_mail_recipients WHERE id=? AND batchId=? FOR UPDATE',[recipientId,id],db);
    if(!recipient||recipient.status!=='unknown')throw new HttpError(409,'Chỉ cho phép gửi lại lượt chưa xác định.');
    if(recipient.retryConsumedBy)throw new HttpError(409,'Quyền gửi lại đã được sử dụng.');
    if(recipient.retryAuthorizedAt)return;
    await run('UPDATE direct_mail_recipients SET retryAuthorizedAt=UTC_TIMESTAMP(3),retryAuthorizedBy=?,retryReason=? WHERE id=?',[user.id,reason.trim(),recipientId],db);
    await refreshReviewStatus(id,db);
    await audit(user.id,'direct_mail_retry_authorized','direct_mail_recipient',recipientId,{reason:reason.trim(),acceptedDuplicateRisk:true,originalStatus:'unknown'},db);
    await notify(batch.ownerId,'Đã cho phép gửi lại một lần',recipient.email+' · Kết quả lượt cũ vẫn chưa xác định.','warning',db);
  });
}
export async function reconcileDirectMail(user:User,id:string,recipientId:string,result:'accepted'|'not_sent',evidence:string){
  if(user.role!=='admin')throw new HttpError(403,'Chỉ quản trị viên được đối soát lượt gửi.');
  await transaction(async db=>{
    const batch=await directBatch(user,id,db,true);
    const [recipient]=await rows('SELECT * FROM direct_mail_recipients WHERE id=? AND batchId=? FOR UPDATE',[recipientId,id],db);
    if(!recipient||recipient.status!=='unknown')throw new HttpError(409,'Chỉ đối soát lượt gửi chưa xác định.');
    await run("UPDATE direct_mail_recipients SET status=?,sentAt=IF(?='accepted',claimedAt,NULL),error=? WHERE id=?",[result==='accepted'?'accepted':'failed',result,'Đối soát: '+evidence,recipientId],db);
    if(result==='accepted'&&recipient.contactId)await run("UPDATE contacts SET lastContactedAt=GREATEST(COALESCE(lastContactedAt,'2000-01-01'),?) WHERE id=?",[recipient.claimedAt,recipient.contactId],db);
    await refreshReviewStatus(batch.id,db);
    await audit(user.id,'direct_mail_reconciled','direct_mail_recipient',recipientId,{result,evidence},db);
    await notify(batch.ownerId,'Đã đối soát email trực tiếp',recipient.email,'info',db);
  });
}
type DirectEnvelope={ownerId:string;senderName:string;email:string;subject:string;body:string;messageId:string;contactId:string};
export type DirectSender=(envelope:DirectEnvelope)=>Promise<void>;
async function sendDirect(envelope:DirectEnvelope){
  const content=await messageContent(envelope.contactId,envelope.body);
  const [box]=await rows('SELECT id FROM mailboxes WHERE userId=?',[envelope.ownerId]);
  if(box){await sendOAuth(envelope.ownerId,envelope.email,envelope.subject,content.text,envelope.messageId,content.headers);return;}
  await sendSmtpMail({from:{name:envelope.senderName,address:process.env.SMTP_FROM_EMAIL!},replyTo:process.env.SMTP_REPLY_TO||process.env.SMTP_FROM_EMAIL,to:envelope.email,subject:envelope.subject,messageId:envelope.messageId,...content});
}
function productSnapshot(value:unknown):Record<string,string|number>|null{return !value?null:typeof value==='string'?JSON.parse(value):value as Record<string,string|number>;}
// Injectable transport is only an in-process testing seam, never a client/API option.
export async function dispatchDirectRecipient(recipientId:string,send:DirectSender=sendDirect){
  const claim=await transaction(async db=>{
    const [ref]=await rows('SELECT batchId FROM direct_mail_recipients WHERE id=?',[recipientId],db);if(!ref)return null;
    const [batch]=await rows('SELECT * FROM direct_mail_batches WHERE id=? FOR UPDATE',[ref.batchId],db);
    const [r]=await rows('SELECT * FROM direct_mail_recipients WHERE id=? FOR UPDATE',[recipientId],db);
    if(r.status!=='pending'||!['queued','running'].includes(batch.status)||await sendingGate(batch.ownerId,db))return null;
    if(!r.contactId){await run("UPDATE direct_mail_recipients SET status='skipped',error='Liên hệ đã bị xóa.' WHERE id=?",[r.id],db);return null;}
    await rows('SELECT a.id FROM accounts a JOIN contacts c ON c.accountId=a.id WHERE c.id=? FOR UPDATE',[r.contactId],db);
    const [c]=await contactsFor([r.contactId],db,batch.id),[owner]=await rows('SELECT active FROM users WHERE id=?',[batch.ownerId],db);
    const product=productSnapshot(batch.productSnapshot);
    let reason=c?contactReason(c,{ownerId:batch.ownerId,recipientPolicy:batch.recipientPolicy} as DirectMailInput,product):'Liên hệ đã bị xóa.';
    if(!owner?.active)reason='Sale gửi đã ngừng hoạt động.';
    if(c?.email!==r.email)reason='Địa chỉ email đã thay đổi sau khi xác nhận.';
    let content:null|{subject:string;body:string}=null;
    try{if(c)content=renderMail(batch.subject,batch.body,c,product,batch.senderName);}catch(e){reason=(e as Error).message;}
    if(reason||!content){await run("UPDATE direct_mail_recipients SET status='skipped',error=? WHERE id=?",[reason||'Nội dung không hợp lệ.',r.id],db);return null;}
    const messageId=`<direct-${r.id}@${new URL(appOrigin()).hostname}>`;
    await run("UPDATE direct_mail_recipients SET status='sending',attempts=attempts+1,claimedAt=UTC_TIMESTAMP(3),messageId=?,renderedSubject=?,renderedBody=? WHERE id=?",[messageId,content.subject,content.body,r.id],db);
    await run("UPDATE direct_mail_batches SET status='running' WHERE id=?",[batch.id],db);
    return {r,batch,c,content,messageId};
  });
  if(!claim)return false;
  try{
    // Recheck refusal, ownership and stop controls after claim, immediately before network dispatch.
    const [batch]=await rows('SELECT status FROM direct_mail_batches WHERE id=?',[claim.batch.id]);
    const [c]=await contactsFor([claim.r.contactId],undefined,claim.batch.id);
    const reason=await sendingGate(claim.batch.ownerId)||(!['queued','running'].includes(batch.status)?'Lượt gửi đã tạm dừng hoặc hủy.':null)||(!c?'Liên hệ đã bị xóa.':contactReason(c,{ownerId:claim.batch.ownerId,recipientPolicy:claim.batch.recipientPolicy} as DirectMailInput,productSnapshot(claim.batch.productSnapshot)))||(c.email!==claim.r.email?'Địa chỉ email đã thay đổi.':null);
    if(reason){await run("UPDATE direct_mail_recipients SET status='skipped',error=? WHERE id=?",[reason,claim.r.id]);return false;}
    await send({ownerId:claim.batch.ownerId,senderName:claim.batch.senderName,email:claim.r.email,subject:claim.content.subject,body:claim.content.body,messageId:claim.messageId,contactId:claim.r.contactId});
    await transaction(async db=>{
      await run("UPDATE direct_mail_recipients SET status='accepted',sentAt=UTC_TIMESTAMP(3),error=NULL WHERE id=? AND status='sending'",[claim.r.id],db);
      await run('UPDATE contacts SET lastContactedAt=UTC_TIMESTAMP(3) WHERE id=?',[claim.r.contactId],db);
      await run("UPDATE accounts SET stage='contacted' WHERE id=? AND stage IN ('new','qualified','eligible')",[claim.c.accountId],db);
      await audit(claim.batch.ownerId,'direct_mail_accepted','direct_mail_recipient',claim.r.id,{},db);
      await notify(claim.batch.ownerId,'Email trực tiếp được nhà cung cấp chấp nhận',claim.r.email,'success',db);
    });
  }catch(error){
    const failure=deliveryFailure(error);
    await run('UPDATE direct_mail_recipients SET status=?,error=? WHERE id=?',[failure.status,failure.message,claim.r.id]);
    await notify(claim.batch.ownerId,failure.status==='failed'?'Gửi trực tiếp có lỗi':'Gửi trực tiếp cần đối soát',claim.r.email,'warning');
  }
  return true;
}
export async function finishDirectBatches(){
  await run("UPDATE direct_mail_batches b SET status=IF(EXISTS(SELECT 1 FROM direct_mail_recipients r WHERE r.batchId=b.id AND r.status='unknown' AND r.retryAuthorizedAt IS NULL),'needs_review',IF(EXISTS(SELECT 1 FROM direct_mail_recipients r WHERE r.batchId=b.id AND r.status='unknown'),'review_released','completed')),finishedAt=UTC_TIMESTAMP(3) WHERE b.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM direct_mail_recipients r WHERE r.batchId=b.id AND r.status IN ('pending','sending'))");
}
export async function runDirectQueue(){
  const lock=await pool().getConnection();
  try{
    const [result]=await lock.query('SELECT GET_LOCK(?,0) acquired',[DIRECT_QUEUE_LOCK]);
    if(!(result as {acquired:number}[])[0].acquired)return;
    await run("UPDATE direct_mail_recipients SET status='unknown',error='Tiến trình gián đoạn sau khi bắt đầu gửi. Cần đối soát; không tự gửi lại.' WHERE status='sending' AND claimedAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE)");
    const started=Date.now();
    for(let i=0;i<5&&Date.now()-started<10000;i++){
      const candidates=await rows("SELECT r.id,b.ownerId FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE r.status='pending' AND b.status IN ('queued','running') ORDER BY b.createdAt,r.id LIMIT 100");
      let next:null|string=null;
      for(const candidate of candidates)if(!await sendingGate(candidate.ownerId)){next=candidate.id;break;}
      if(!next)break;
      await dispatchDirectRecipient(next);
    }
    await finishDirectBatches();
  }finally{await lock.query('SELECT RELEASE_LOCK(?)',[DIRECT_QUEUE_LOCK]);lock.release();}
}

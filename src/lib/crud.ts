import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {HttpError,ownAccount,requireAdmin,type User} from './auth';
import {rows,run,transaction,sqlDate,type DB} from './db';
import {audit,notify} from './activity';
import {suppress} from './mail';
import {workspace} from './workspace';
import * as schemas from './schemas';
import {bulkDeleteContacts} from './bulk-contacts';

const tables={accounts:'accounts',contacts:'contacts',products:'products',templates:'templates',campaigns:'campaigns',tasks:'tasks',rfqs:'rfqs',quotes:'quotes',messages:'inbound_messages',users:'users',suppressions:'suppressions'} as const;
type Resource=keyof typeof tables;
async function readBody(request:Request){if(Number(request.headers.get('content-length')||0)>3_000_000)throw new HttpError(413,'Dữ liệu quá lớn.');const raw=await request.text();if(Buffer.byteLength(raw)>3_000_000)throw new HttpError(413,'Dữ liệu quá lớn.');return raw?JSON.parse(raw):{};}
const classifications=z.enum(['unclassified','positive','rfq','not_now','wrong_person','unsubscribe']);
const stages=z.enum(['new','qualified','eligible','contacted','replied','rfq','quoted','won','lost']);
const rfqOutcome=z.object({status:z.enum(['new','working','quoted','won','lost']),bookingReference:z.string().trim().max(120).default(''),revenue:z.coerce.number().nonnegative().max(1e12).default(0),grossMargin:z.coerce.number().min(-1e12).max(1e12).default(0)});
const messageSchema=z.object({contactId:schemas.id,subject:z.string().trim().min(1).max(500),body:z.string().trim().min(1).max(100000),classification:classifications.default('unclassified'),receivedAt:z.iso.datetime({offset:true})});

async function record(user:User,resource:Resource,id:string,db:DB,lock=false){
  schemas.id.parse(id);
  const [item]=await rows(`SELECT * FROM ${tables[resource]} WHERE id=?${lock?' FOR UPDATE':''}`,[id],db);
  if(!item)throw new HttpError(404,'Bản ghi không còn tồn tại. Hãy tải lại danh sách.');
  if(resource==='users')requireAdmin(user);
  if(resource==='accounts')await ownAccount(user,id,db);
  if(resource==='contacts'||resource==='rfqs')await ownAccount(user,item.accountId,db);
  if(resource==='campaigns'||resource==='tasks')if(user.role!=='admin'&&item.ownerId!==user.id)throw new HttpError(403,'Bạn không phụ trách bản ghi này.');
  if(resource==='tasks'&&item.accountId)await ownAccount(user,item.accountId,db);
  if(resource==='quotes'){const [parent]=await rows('SELECT accountId FROM rfqs WHERE id=?',[item.rfqId],db);await ownAccount(user,parent.accountId,db);}
  if(resource==='messages'){const [parent]=await rows('SELECT accountId FROM contacts WHERE id=?',[item.contactId],db);await ownAccount(user,parent.accountId,db);}
  if(resource==='suppressions'&&user.role!=='admin'){
    const [contact]=await rows('SELECT accountId FROM contacts WHERE email=?',[item.email],db);
    if(!contact)throw new HttpError(403,'Không có quyền xem bản ghi này.');await ownAccount(user,contact.accountId,db);
  }
  return item;
}
async function activeOwner(id:string,db:DB){const [owner]=await rows('SELECT id FROM users WHERE id=? AND active=TRUE',[id],db);if(!owner)throw new HttpError(400,'Người phụ trách phải là thành viên đang hoạt động.');}
async function preventReferences(query:string,id:string,message:string,db:DB){if((await rows(query,[id],db)).length)throw new HttpError(409,message);}
async function stopPending(contactId:string,db:DB){
  await preventReferences("SELECT id FROM campaign_recipients WHERE contactId=? AND status IN ('sending','unknown') LIMIT 1",contactId,'Liên hệ có lượt gửi đang xử lý hoặc cần đối soát. Hãy xử lý lượt gửi trước.',db);
  await run("UPDATE campaigns SET status='draft',approvedAt=NULL,approvedBy=NULL WHERE id IN (SELECT campaignId FROM campaign_recipients WHERE contactId=?) AND status IN ('approved','scheduled','running','paused')",[contactId],db);
}

async function remove(user:User,resource:Resource,id:string,body:unknown){
  return transaction(async db=>{
    const old=await record(user,resource,id,db,true);
    if(resource==='accounts'){
      // Keep foreign keys and operational history intact. Serialize with worker claims.
      const recipients=await rows('SELECT r.id,r.status FROM campaign_recipients r JOIN contacts c ON c.id=r.contactId WHERE c.accountId=? ORDER BY r.id FOR UPDATE',[id],db);
      if(recipients.some(r=>r.status==='sending'))throw new HttpError(409,'Đại lý đang có email được gửi. Vui lòng đợi lượt gửi hoàn tất rồi xóa lại.');
      const result=await run("UPDATE campaign_recipients r JOIN contacts c ON c.id=r.contactId SET r.status='skipped',r.error='Đại lý đã bị xóa' WHERE c.accountId=? AND r.status='pending'",[id],db);
      await run('UPDATE accounts SET deletedAt=UTC_TIMESTAMP(3) WHERE id=?',[id],db);
      await audit(user.id,'accounts_deleted','accounts',id,{snapshot:old,softDelete:true,stoppedRecipients:result.affectedRows},db);
      await notify(old.ownerId,'Đã xóa đại lý',String(old.name||'Đại lý chưa bổ sung tên')+'; đã dừng các email chờ gửi. Lịch sử được giữ lại.','info',db);
      return {ok:true,softDeleted:true,stoppedRecipients:result.affectedRows};
    }
    if(resource==='contacts'){
      await preventReferences('SELECT id FROM campaign_recipients WHERE contactId=? LIMIT 1',id,'Liên hệ đang có trong chiến dịch. Hãy xóa chiến dịch nháp liên quan trước; lịch sử gửi được giữ để đối soát.',db);
      await preventReferences('SELECT id FROM inbound_messages WHERE contactId=? LIMIT 1',id,'Liên hệ còn thư phản hồi. Hãy xử lý thư phản hồi trước khi xóa.',db);
      await run('DELETE FROM consent_events WHERE contactId=?',[id],db);
      // Suppression is keyed by email and deliberately survives contact deletion.
    }
    if(resource==='products'||resource==='templates'){
      await preventReferences(`SELECT id FROM campaigns WHERE ${resource==='products'?'productId':'templateId'}=? LIMIT 1`,id,'Bản ghi đang được chiến dịch sử dụng. Hãy xử lý chiến dịch liên quan trước khi xóa.',db);
      if(resource==='products'){await run('DELETE FROM product_versions WHERE productId=?',[id],db);await run("DELETE FROM private_files WHERE parentType='product' AND parentId=?",[id],db);}
    }
    if(resource==='campaigns'){
      if(!['draft','cancelled'].includes(old.status))throw new HttpError(409,'Chỉ xóa chiến dịch nháp hoặc đã hủy chưa từng gửi.');
      await preventReferences("SELECT id FROM campaign_recipients WHERE campaignId=? AND (attempts>0 OR status IN ('sending','unknown','accepted','failed') OR sentAt IS NOT NULL OR claimedAt IS NOT NULL) LIMIT 1",id,'Chiến dịch có lịch sử gửi; không thể xóa. Bạn có thể hủy chiến dịch để dừng các lượt còn lại.',db);
      await run('DELETE FROM campaign_recipients WHERE campaignId=?',[id],db);
    }
    if(resource==='quotes'){
      await run("INSERT INTO settings(settingKey,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=GREATEST(CAST(value AS UNSIGNED),CAST(VALUES(value) AS UNSIGNED))",['quote_sequence_'+old.rfqId,String(old.version)],db);
      await run("UPDATE rfqs SET status='working' WHERE id=? AND status='quoted' AND NOT EXISTS (SELECT 1 FROM quotes WHERE rfqId=? AND id<>?)",[old.rfqId,old.rfqId,id],db);
    }
    if(resource==='rfqs'){
      await preventReferences('SELECT id FROM quotes WHERE rfqId=? LIMIT 1',id,'RFQ còn báo giá. Hãy xử lý các báo giá trước khi xóa RFQ.',db);
      if(old.status==='won')throw new HttpError(409,'RFQ đã booking cần được cập nhật kết quả trước khi xóa.');
      await run("DELETE FROM private_files WHERE parentType='rfq' AND parentId=?",[id],db);
      await run('DELETE FROM settings WHERE settingKey=?',['quote_sequence_'+id],db);
    }
    if(resource==='users'){
      if(id===user.id)throw new HttpError(409,'Không thể xóa tài khoản đang đăng nhập.');
      if(old.active&&old.role==='admin'){
        const admins=await rows("SELECT id FROM users WHERE role='admin' AND active=TRUE ORDER BY id FOR UPDATE",[],db);
        if(admins.length<=1)throw new HttpError(409,'Cần giữ ít nhất một quản trị viên đang hoạt động.');
      }
      const references=[['accounts','ownerId'],['tasks','ownerId'],['rfqs','ownerId'],['campaigns','ownerId'],['campaigns','approvedBy'],['contacts','reviewedBy'],['consent_events','actorId'],['suppressions','actorId'],['private_files','actorId'],['import_batches','actorId']];
      for(const [table,column]of references)await preventReferences(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`,id,'Thành viên còn hồ sơ hoặc lịch sử nghiệp vụ. Chuyển người phụ trách và ngừng hoạt động tài khoản để giữ lịch sử.',db);
      await run('DELETE FROM mailboxes WHERE userId=?',[id],db);await run('DELETE FROM oauth_states WHERE userId=?',[id],db);await run('DELETE FROM notifications WHERE userId=?',[id],db);
    }
    if(resource==='suppressions'){
      requireAdmin(user);const data=z.object({evidence:z.string().trim().min(20).max(2000)}).parse(body);
      if(old.reason!=='manual')throw new HttpError(409,'Chặn do từ chối, bounce hoặc khiếu nại được giữ lại. Chỉ gỡ được mục chặn thủ công.');
      await run("UPDATE contacts SET consentStatus='unreviewed',consentPurpose='',consentEvidence='',consentAt=NULL,reviewedBy=NULL WHERE email=?",[old.email],db);
      await audit(user.id,'manual_suppression_removed','suppression',id,{email:old.email,evidence:data.evidence},db);
    }
    await run(`DELETE FROM ${tables[resource]} WHERE id=?`,[id],db);
    const snapshot={...old};delete snapshot.passwordHash;delete snapshot.body;
    await audit(user.id,resource+'_deleted',resource,id,{snapshot},db);
    await notify(resource==='products'||resource==='templates'?null:user.id,'Đã xóa bản ghi',String(old.name||old.title||old.email||old.subject||'Bản ghi đã được xóa.'),'info',db);
    return {ok:true};
  });
}

async function update(user:User,resource:Resource,id:string,body:unknown){return transaction(async db=>{
  const old=await record(user,resource,id,db,true);
  if(resource==='accounts'){
    const data=schemas.accountSchema.extend({stage:stages}).parse(body),ownerId=user.role==='admin'?(data.ownerId||old.ownerId):old.ownerId;
    if(user.role!=='admin'&&data.ownerId&&data.ownerId!==old.ownerId)throw new HttpError(403,'Chỉ quản trị viên được chuyển người phụ trách.');await activeOwner(ownerId,db);
    await preventReferences("SELECT r.id FROM campaign_recipients r JOIN contacts c ON c.id=r.contactId WHERE c.accountId=? AND r.status IN ('sending','unknown') LIMIT 1",id,'Đại lý có lượt gửi đang xử lý hoặc cần đối soát.',db);
    await run('UPDATE accounts SET name=?,website=?,region=?,market=?,segment=?,tier=?,ownerId=?,notes=?,stage=? WHERE id=?',[data.name,data.website,data.region,data.market,data.segment,data.tier,ownerId,data.notes,data.stage,id],db);
    await run("UPDATE campaigns SET status='draft',approvedAt=NULL,approvedBy=NULL WHERE id IN (SELECT r.campaignId FROM campaign_recipients r JOIN contacts c ON c.id=r.contactId WHERE c.accountId=?) AND status IN ('approved','scheduled','running','paused')",[id],db);
    if(ownerId!==old.ownerId){await run('UPDATE tasks SET ownerId=? WHERE accountId=?',[ownerId,id],db);await run('UPDATE rfqs SET ownerId=? WHERE accountId=?',[ownerId,id],db);await run("UPDATE campaign_recipients r JOIN contacts c ON c.id=r.contactId SET r.status='skipped',r.error='Đại lý đã chuyển sale' WHERE c.accountId=? AND r.status='pending'",[id],db);}
  }else if(resource==='contacts'){
    const data=schemas.contactSchema.parse(body);await ownAccount(user,data.accountId,db);await stopPending(id,db);
    const identityChanged=data.email!==old.email||data.accountId!==old.accountId||data.country!==old.country||data.source!==old.source;
    if(identityChanged)await preventReferences('SELECT id FROM campaign_recipients WHERE contactId=? LIMIT 1',id,'Không thể đổi email, đại lý, quốc gia hoặc nguồn của liên hệ đã có trong chiến dịch. Tạo liên hệ mới để giữ đúng lịch sử.',db);
    const suppressed=(await rows('SELECT id FROM suppressions WHERE email=?',[data.email],db)).length>0;
    const status=suppressed?'suppressed':identityChanged?'unreviewed':old.consentStatus;
    await run('UPDATE contacts SET accountId=?,name=?,email=?,title=?,source=?,country=?,consentStatus=?,consentPurpose=?,consentEvidence=?,consentAt=?,reviewedBy=? WHERE id=?',[data.accountId,data.name,data.email,data.title,data.source,data.country,status,identityChanged?'':old.consentPurpose,identityChanged?'':old.consentEvidence,identityChanged?null:old.consentAt,identityChanged?null:old.reviewedBy,id],db);
  }else if(resource==='tasks'){
    const data=schemas.taskSchema.extend({status:z.enum(['open','done'])}).parse(body),ownerId=user.role==='admin'?(data.ownerId||old.ownerId):old.ownerId;await activeOwner(ownerId,db);
    if(data.accountId){const account=await ownAccount(user,data.accountId,db);if(account.ownerId!==ownerId)throw new HttpError(409,'Công việc phải giao đúng người phụ trách đại lý.');}
    await run('UPDATE tasks SET title=?,accountId=?,ownerId=?,dueAt=?,priority=?,status=? WHERE id=?',[data.title,data.accountId||null,ownerId,sqlDate(data.dueAt),data.priority,data.status,id],db);
  }else if(resource==='rfqs'){
    const data=schemas.rfqSchema.merge(rfqOutcome).parse(body);const account=await ownAccount(user,data.accountId,db);
    if(data.status==='won'&&(!data.bookingReference||data.revenue<=0))throw new HttpError(400,'Booking thắng cần mã và doanh thu.');
    if(data.accountId!==old.accountId)await preventReferences('SELECT id FROM quotes WHERE rfqId=? LIMIT 1',id,'RFQ có báo giá không thể chuyển sang đại lý khác.',db);
    await run('UPDATE rfqs SET accountId=?,ownerId=?,title=?,destination=?,departureDate=?,pax=?,budget=?,deadline=?,notes=?,status=?,bookingReference=?,revenue=?,grossMargin=? WHERE id=?',[data.accountId,account.ownerId,data.title,data.destination,data.departureDate||null,data.pax,data.budget,data.deadline||null,data.notes,data.status,data.bookingReference,data.revenue,data.grossMargin,id],db);
    if(['won','quoted','lost'].includes(data.status))await run('UPDATE accounts SET stage=? WHERE id=?',[data.status,data.accountId],db);
  }else if(resource==='quotes'){
    const data=schemas.quoteSchema.parse(body);if(data.rfqId!==old.rfqId)throw new HttpError(409,'Không thể chuyển phiên bản báo giá sang RFQ khác.');
    await run('UPDATE quotes SET amount=?,currency=?,validUntil=?,conditions=? WHERE id=?',[data.amount,data.currency,data.validUntil,data.conditions,id],db);
  }else if(resource==='messages'){
    const data=messageSchema.parse(body);if(data.contactId!==old.contactId)throw new HttpError(409,'Không thể chuyển thư phản hồi sang liên hệ khác.');
    await run('UPDATE inbound_messages SET subject=?,body=?,classification=?,receivedAt=? WHERE id=?',[data.subject,data.body,data.classification,sqlDate(data.receivedAt),id],db);
    if(data.classification==='unsubscribe')await suppress((await rows('SELECT email FROM contacts WHERE id=?',[old.contactId],db))[0].email,'unsubscribe',user.id,db);
  }else if(resource==='users'){
    requireAdmin(user);const data=schemas.userSchema.omit({password:true}).extend({active:z.boolean(),password:z.string().min(12).max(128).optional()}).parse(body);
    if(id===user.id&&(!data.active||data.role!=='admin'))throw new HttpError(409,'Không thể tự ngừng hoạt động hoặc hạ quyền tài khoản đang đăng nhập.');
    // A shared lock serializes edits of administrators, including concurrent demotions.
    const admins=await rows("SELECT id FROM users WHERE role='admin' AND active=TRUE ORDER BY id FOR UPDATE",[],db);
    if(old.role==='admin'&&old.active&&(!data.active||data.role!=='admin')&&admins.length<=1)throw new HttpError(409,'Cần giữ ít nhất một quản trị viên đang hoạt động.');
    await run('UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?',[data.name,data.email,data.role,data.active,id],db);
    if(data.password)await run('UPDATE users SET passwordHash=? WHERE id=?',[await bcrypt.hash(data.password,12),id],db);
    if(!data.active||data.role!==old.role||data.email!==old.email||data.password)await run('DELETE FROM sessions WHERE userId=?',[id],db);
    if(!data.active)await run("UPDATE campaigns SET status='paused' WHERE ownerId=? AND status IN ('approved','scheduled','running')",[id],db);
  }else if(resource==='suppressions'){
    requireAdmin(user);const data=z.object({reason:z.enum(['manual','unsubscribe','hard_bounce','complaint'])}).parse(body);
    if(old.reason!=='manual'&&data.reason!==old.reason)throw new HttpError(409,'Không thể thay đổi lý do từ chối, bounce hoặc khiếu nại đã ghi nhận.');
    await run('UPDATE suppressions SET reason=? WHERE id=?',[data.reason,id],db);
  }else if(resource==='campaigns'){
    const data=schemas.campaignSchema.parse(body);
    if(old.status!=='draft')throw new HttpError(409,'Chỉ sửa nội dung chiến dịch nháp. Hãy tạm dừng hoặc tạo chiến dịch mới nếu đã triển khai.');
    await preventReferences("SELECT id FROM campaign_recipients WHERE campaignId=? AND (attempts>0 OR status NOT IN ('pending','skipped') OR claimedAt IS NOT NULL) LIMIT 1",id,'Chiến dịch đã có lượt gửi; không thể sửa danh sách hoặc nội dung.',db);
    const ownerId=user.role==='admin'?(data.ownerId||old.ownerId):old.ownerId;await activeOwner(ownerId,db);
    const contacts=await rows(`SELECT c.id,c.accountId,a.ownerId FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.deletedAt IS NULL AND c.id IN (${data.contactIds.map(()=>'?').join(',')})`,data.contactIds,db);
    if(contacts.length!==new Set(data.contactIds).size||contacts.some(c=>c.ownerId!==ownerId)||new Set(contacts.map(c=>c.accountId)).size!==contacts.length)throw new HttpError(409,'Chọn một liên hệ mỗi đại lý, thuộc cùng sale phụ trách chiến dịch.');
    await run('UPDATE campaigns SET name=?,ownerId=?,templateId=?,productId=?,recipientPolicy=?,followupBody=?,followupDays=?,approvedAt=NULL,approvedBy=NULL,scheduledAt=NULL WHERE id=?',[data.name,ownerId,data.templateId,data.productId,data.recipientPolicy,data.followupBody,data.followupDays,id],db);
    await run('DELETE FROM campaign_recipients WHERE campaignId=?',[id],db);
    for(const contactId of new Set(data.contactIds))await run('INSERT INTO campaign_recipients(id,campaignId,contactId) VALUES (?,?,?)',[randomUUID(),id,contactId],db);
  }else throw new HttpError(404,'Không tìm thấy thao tác cập nhật.');
  const before={...old};delete before.passwordHash;
  await audit(user.id,resource+'_updated',resource,id,{before},db);await notify(resource==='users'||resource==='suppressions'?null:user.id,'Đã cập nhật bản ghi',String(old.name||old.title||old.email||old.subject||''),'info',db);
  return {ok:true};
});}

export async function handleCrud(request:Request,user:User,name:string,id?:string,action?:string):Promise<Response|undefined>{
  if(!Object.hasOwn(tables,name))return;const resource=name as Resource,method=request.method;
  const ok=(data:unknown)=>Response.json(data,{headers:{'Cache-Control':'no-store'}});
  if(resource==='contacts'&&id==='bulk-delete'&&method==='POST')return ok(await bulkDeleteContacts(user,await readBody(request)));
  if(method==='GET'){
    if(id&&resource==='campaigns')return;
    if(!id){if(resource==='users')requireAdmin(user);const state=await workspace(user);return ok(state[resource==='messages'?'messages':resource]);}
    return transaction(async db=>{const item=await record(user,resource,id,db);if(resource==='users')delete item.passwordHash;return ok(item);});
  }
  if(method==='DELETE'&&id)return ok(await remove(user,resource,id,await readBody(request)));
  if(method==='PATCH'&&id&&(action==='details'||['quotes','users','suppressions'].includes(resource)))return ok(await update(user,resource,id,await readBody(request)));
  if(method==='POST'&&resource==='messages'&&!id){
    const data=messageSchema.parse(await readBody(request)),messageId=randomUUID();
    await transaction(async db=>{
      const contact=await record(user,'contacts',data.contactId,db,true);
      await run('INSERT INTO inbound_messages(id,contactId,subject,body,classification,receivedAt) VALUES (?,?,?,?,?,?)',[messageId,data.contactId,data.subject,data.body,data.classification,sqlDate(data.receivedAt)],db);
      await run('UPDATE contacts SET lastReplyAt=GREATEST(COALESCE(lastReplyAt,?),?) WHERE id=?',[sqlDate(data.receivedAt),sqlDate(data.receivedAt),data.contactId],db);
      await run("UPDATE campaign_recipients SET status='skipped',repliedAt=?,error='Đã nhận phản hồi' WHERE contactId=? AND status='pending'",[sqlDate(data.receivedAt),data.contactId],db);
      await run("UPDATE accounts SET stage='replied' WHERE id=? AND stage IN ('new','qualified','eligible','contacted')",[contact.accountId],db);
      if(data.classification==='unsubscribe')await suppress(contact.email,'unsubscribe',user.id,db);
      await audit(user.id,'reply_recorded','message',messageId,{},db);await notify(user.id,'Đã ghi nhận phản hồi',data.subject,'info',db);
    });return ok({id:messageId});
  }
}

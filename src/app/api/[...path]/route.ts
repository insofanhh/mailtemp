import {createHash,randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {requireUser,requireAdmin,sameOrigin,HttpError,ownAccount,createSession,hash,COOKIE,type User} from '@/lib/auth';
import {cookies} from 'next/headers';
import {rows,run,transaction,sqlDate} from '@/lib/db';
import {audit,notify,setting} from '@/lib/activity';
import {workspace} from '@/lib/workspace';
import * as schemas from '@/lib/schemas';
import {handleCrud} from '@/lib/crud';
import {blockReason,normalizeEmail} from '@/lib/policy';
import {suppress,renderMail,smtpTransport,mailReady} from '@/lib/mail';
import {directMailSchema,directStartSchema,directRetrySchema} from '@/lib/direct-mail-schema';
import {previewDirectMail,startDirectMail,directMailList,directMailDetails,controlDirectMail,reconcileDirectMail,authorizeDirectRetry} from '@/lib/direct-mail';
import {DIRECT_SCHEDULED_BLOCK_SQL} from '@/lib/direct-mail-conflicts';
import {oauthStart,oauthCallback,syncMailbox} from '@/lib/oauth';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
const ok=(data:unknown={ok:true})=>NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
async function json(request:Request){if(Number(request.headers.get('content-length')||0)>3_000_000)throw new HttpError(413,'Dữ liệu quá lớn.');const raw=await request.text();if(raw.length>3_000_000)throw new HttpError(413,'Dữ liệu quá lớn.');return JSON.parse(raw);}
async function ownedCampaign(user:User,id:string,db?:Parameters<typeof rows>[2],lock=false){const [c]=await rows('SELECT * FROM campaigns WHERE id=?'+(lock?' FOR UPDATE':''),[id],db);if(!c)throw new HttpError(404,'Không tìm thấy chiến dịch.');if(user.role!=='admin'&&c.ownerId!==user.id)throw new HttpError(403,'Chiến dịch thuộc sale khác.');return c;}
async function campaignPreview(user:User,id:string,db?:Parameters<typeof rows>[2]){
  const campaign=await ownedCampaign(user,id,db);
  const [template]=await rows('SELECT * FROM templates WHERE id=?',[campaign.templateId],db);
  const product=campaign.productId?(await rows('SELECT * FROM products WHERE id=?',[campaign.productId],db))[0]||null:null;
  if(campaign.productId&&!product)throw new HttpError(409,'Không tìm thấy chương trình / bảng giá đã chọn.');
  const [sender]=await rows('SELECT name,active FROM users WHERE id=?',[campaign.ownerId],db);
  const contacts=await rows('SELECT c.*,a.name accountName,a.tier,a.ownerId,a.deletedAt accountDeletedAt,s.id suppressionId,r.status deliveryStatus,r.error deliveryError FROM campaign_recipients r JOIN contacts c ON c.id=r.contactId JOIN accounts a ON a.id=c.accountId LEFT JOIN suppressions s ON s.email=c.email WHERE r.campaignId=? AND r.step=0 ORDER BY c.id',[id],db);
  const conflicts=await rows("SELECT DISTINCT c.accountId FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId JOIN contacts c ON c.id=r.contactId WHERE r.campaignId<>? AND c.accountId IN (SELECT c2.accountId FROM campaign_recipients r2 JOIN contacts c2 ON c2.id=r2.contactId WHERE r2.campaignId=?) AND (r.status IN ('sending','unknown') OR (r.status='pending' AND p.status IN ('approved','scheduled','running','paused')))",[id,id],db);
  const directConflicts=await rows(`SELECT DISTINCT r.email FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE r.email IN (SELECT c2.email FROM campaign_recipients r2 JOIN contacts c2 ON c2.id=r2.contactId WHERE r2.campaignId=?) AND ${DIRECT_SCHEDULED_BLOCK_SQL}`,[id],db);
  const conflictingAccounts=new Set(conflicts.map(c=>c.accountId)),directEmails=new Set(directConflicts.map(c=>normalizeEmail(c.email)));
  const recipients=contacts.map(c=>{let reason=blockReason({recipientPolicy:campaign.recipientPolicy,hasProduct:Boolean(campaign.productId),accountDeletedAt:c.accountDeletedAt,consentStatus:c.consentStatus,evidence:c.consentEvidence,purpose:c.consentPurpose,country:c.country,suppressed:Boolean(c.suppressionId),source:c.source,validUntil:product?.validUntil||'',tier:c.tier,productTier:product?.tier||'',lastReplyAt:c.lastReplyAt,approvedAt:campaign.approvedAt,lastContactedAt:c.lastContactedAt});if(c.ownerId!==campaign.ownerId)reason='Đại lý đã chuyển người phụ trách.';let preview:null|{subject:string;body:string}=null;try{preview=renderMail(template.subject,template.body,c,product,sender.name);if(campaign.followupBody?.trim())renderMail(template.subject,campaign.followupBody,c,product,sender.name);}catch(e){reason=(e as Error).message;}if(conflictingAccounts.has(c.accountId)||directEmails.has(normalizeEmail(c.email)))reason='Đại lý đã có lượt gửi hoạt động hoặc cần đối soát trong chiến dịch khác.';if(!sender?.active)reason='Sale gửi đã ngừng hoạt động.';if(c.accountDeletedAt)reason='Đại lý đã bị xóa.';if(c.deliveryStatus!=='pending')reason=c.deliveryStatus==='skipped'?(c.deliveryError||'Lượt gửi đã được bỏ qua.'):'Lượt gửi đã được xử lý ('+c.deliveryStatus+').';return {id:c.id,name:c.name,email:c.email,accountName:c.accountName,consentStatus:c.consentStatus,reason,preview};});
  const previewToken=createHash('sha256').update(JSON.stringify({campaign,templateVersion:template.version,productVersion:product?.version,recipients})).digest('hex');
  return {campaign,product,template,recipients,previewToken,eligible:recipients.filter(c=>!c.reason).length,blocked:recipients.filter(c=>c.reason).length};
}
async function handle(request:Request,context:Context){
  const {path}=await context.params;const [resource,id,action]=path;const method=request.method;
  if(method!=='GET')sameOrigin(request);
  if(resource==='auth'&&id==='login'&&method==='POST'){
    const data=z.object({email:z.email().max(254),password:z.string().min(1).max(128)}).parse(await json(request));
    const key=hash(data.email.toLowerCase());
    await run('INSERT INTO login_attempts(id,attempts,windowStart) VALUES (?,1,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE attempts=IF(windowStart<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE),1,attempts+1),windowStart=IF(windowStart<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE),UTC_TIMESTAMP(3),windowStart)',[key]);
    const [attempt]=await rows('SELECT attempts FROM login_attempts WHERE id=?',[key]);if(attempt.attempts>10)throw new HttpError(429,'Quá nhiều lần thử. Vui lòng đợi 15 phút.');
    const [user]=await rows('SELECT * FROM users WHERE email=? AND active=TRUE',[normalizeEmail(data.email)]);
    if(!user||!await bcrypt.compare(data.password,user.passwordHash))throw new HttpError(401,'Email hoặc mật khẩu không đúng.');
    await run('DELETE FROM login_attempts WHERE id=?',[key]);await createSession(user.id);return ok({user:{id:user.id,name:user.name,email:user.email,role:user.role}});
  }
  const user=await requireUser();
  const crud=await handleCrud(request,user,resource,id,action);if(crud)return crud;
  if(resource==='auth'&&id==='logout'&&method==='POST'){const token=(await cookies()).get(COOKIE)?.value;if(token)await run('DELETE FROM sessions WHERE tokenHash=?',[hash(token)]);(await cookies()).delete(COOKIE);return ok();}
  if(resource==='direct-mail'){
    if(method==='GET')return ok(id?await directMailDetails(user,schemas.id.parse(id)):await directMailList(user));
    if(method==='POST'&&id==='preview')return ok(await previewDirectMail(user,directMailSchema.parse(await json(request))));
    if(method==='POST'&&!id){const data=directStartSchema.parse(await json(request));return ok(await startDirectMail(user,data.input,data.requestId,data.previewToken,data.acceptExclusions,data.acceptDuplicateRisk));}
    if(method==='POST'&&id&&action==='authorize-retry'){const data=directRetrySchema.parse(await json(request));await authorizeDirectRetry(user,schemas.id.parse(id),data.recipientId,data.reason);return ok();}
    if(method==='POST'&&id&&action==='reconcile'){const data=z.object({recipientId:z.uuid(),result:z.enum(['accepted','not_sent']),evidence:z.string().trim().min(20).max(2000)}).parse(await json(request));await reconcileDirectMail(user,schemas.id.parse(id),data.recipientId,data.result,data.evidence);return ok();}
    if(method==='PATCH'&&id){const data=z.object({action:z.enum(['pause','resume','cancel'])}).parse(await json(request));await controlDirectMail(user,schemas.id.parse(id),data.action);return ok();}
  }
  if(resource==='state'&&method==='GET')return ok(await workspace(user));
  if(resource==='oauth'&&['google','microsoft'].includes(id)&&method==='GET'){
    const provider=id as 'google'|'microsoft';if(action==='start')return NextResponse.redirect(await oauthStart(provider,user));
    if(action==='callback'){const url=new URL(request.url);if(url.searchParams.has('error'))throw new HttpError(400,'Người dùng hoặc nhà cung cấp đã từ chối kết nối.');await oauthCallback(provider,user,url.searchParams.get('code')||'',url.searchParams.get('state')||'');await notify(user.id,'Đã kết nối hộp thư',provider,'success');return NextResponse.redirect(`${process.env.APP_URL}/?view=settings`);}
  }
  if(resource==='mailbox'&&method==='POST'){
    if(id==='sync'){await syncMailbox(user.id);return ok();}
    if(id==='disconnect'){await run('DELETE FROM mailboxes WHERE userId=?',[user.id]);await audit(user.id,'mailbox_disconnected','user',user.id);return ok();}
  }
  if(resource==='accounts'&&method==='POST'){
    const data=schemas.accountSchema.parse(await json(request)),ownerId=user.role==='admin'?(data.ownerId||user.id):user.id,accountId=randomUUID();
    await transaction(async db=>{await run('INSERT INTO accounts(id,name,website,region,market,segment,tier,ownerId,notes) VALUES (?,?,?,?,?,?,?,?,?)',[accountId,data.name,data.website,data.region,data.market,data.segment,data.tier,ownerId,data.notes],db);await audit(user.id,'account_created','account',accountId,{},db);await notify(ownerId,'Đã thêm đại lý',data.name,'success',db);});return ok({id:accountId});
  }
  if(resource==='accounts'&&id&&method==='PATCH'){
    const existing=await ownAccount(user,id);const data=z.object({stage:z.enum(['new','qualified','eligible','contacted','replied','rfq','quoted','won','lost']).optional(),notes:z.string().max(5000).optional(),ownerId:schemas.id.optional(),tier:z.string().min(1).max(60).optional()}).parse(await json(request));
    if(data.ownerId)requireAdmin(user);
    await transaction(async db=>{await run('UPDATE accounts SET stage=?,notes=?,ownerId=?,tier=? WHERE id=?',[data.stage||existing.stage,data.notes??existing.notes,data.ownerId||existing.ownerId,data.tier||existing.tier,id],db);if(data.ownerId&&data.ownerId!==existing.ownerId){await run('UPDATE tasks SET ownerId=? WHERE accountId=?',[data.ownerId,id],db);await run('UPDATE rfqs SET ownerId=? WHERE accountId=?',[data.ownerId,id],db);await run("UPDATE campaign_recipients r JOIN contacts c ON c.id=r.contactId SET r.status='skipped',r.error='Đại lý đã chuyển sale' WHERE c.accountId=? AND r.status='pending'",[id],db);}await audit(user.id,'account_updated','account',id,data,db);await notify(data.ownerId||existing.ownerId,'Đã cập nhật đại lý',existing.name,'info',db);});return ok();
  }
  if(resource==='contacts'&&method==='POST'){
    const data=schemas.contactSchema.parse(await json(request));await ownAccount(user,data.accountId);const contactId=randomUUID();
    const suppressed=(await rows('SELECT id FROM suppressions WHERE email=?',[data.email])).length>0;
    await transaction(async db=>{await run('INSERT INTO contacts(id,accountId,name,email,title,source,country,consentStatus) VALUES (?,?,?,?,?,?,?,?)',[contactId,data.accountId,data.name,data.email,data.title,data.source,data.country,suppressed?'suppressed':'unreviewed'],db);await audit(user.id,'contact_created','contact',contactId,{},db);await notify(user.id,'Đã thêm liên hệ',data.email,'success',db);});return ok({id:contactId});
  }
  if(resource==='contacts'&&id&&method==='PATCH'){
    const [contact]=await rows('SELECT * FROM contacts WHERE id=?',[id]);if(!contact)throw new HttpError(404,'Không tìm thấy liên hệ.');await ownAccount(user,contact.accountId);
    const data=schemas.consentSchema.parse(await json(request));if((await rows('SELECT id FROM suppressions WHERE email=?',[contact.email])).length)throw new HttpError(409,'Liên hệ đang bị chặn. Không thể khôi phục bằng thao tác duyệt.');
    await transaction(async db=>{await run('UPDATE contacts SET consentStatus=?,consentPurpose=?,consentEvidence=?,consentAt=UTC_TIMESTAMP(3),reviewedBy=? WHERE id=?',[data.consentStatus,data.consentPurpose,data.consentEvidence,user.id,id],db);await run('INSERT INTO consent_events(id,contactId,actorId,status,purpose,evidence) VALUES (?,?,?,?,?,?)',[randomUUID(),id,user.id,data.consentStatus,data.consentPurpose,data.consentEvidence],db);await audit(user.id,'consent_reviewed','contact',id,{status:data.consentStatus},db);await notify(user.id,'Đã lưu đánh giá liên hệ',contact.email,'success',db);});return ok();
  }
  if(resource==='suppressions'&&method==='POST'){
    const data=z.object({email:z.email(),reason:z.enum(['manual','unsubscribe','hard_bounce','complaint'])}).parse(await json(request));
    const [contact]=await rows('SELECT accountId FROM contacts WHERE email=?',[normalizeEmail(data.email)]);if(contact)await ownAccount(user,contact.accountId);else requireAdmin(user);
    await transaction(db=>suppress(data.email,data.reason,user.id,db));return ok();
  }
  if(resource==='products'&&method==='POST'){
    const data=schemas.productSchema.parse(await json(request)),entityId=randomUUID();await run('INSERT INTO products(id,name,destination,duration,price,currency,unit,tier,validUntil,conditions) VALUES (?,?,?,?,?,?,?,?,?,?)',[entityId,data.name,data.destination,data.duration,data.price,data.currency,data.unit,data.tier,data.validUntil,data.conditions]);await audit(user.id,'product_created','product',entityId);await notify(null,'Đã thêm chương trình',data.name,'success');return ok({id:entityId});
  }
  if(resource==='products'&&id&&method==='PATCH'){
    const data=schemas.productSchema.parse(await json(request));await transaction(async db=>{const [old]=await rows('SELECT * FROM products WHERE id=? FOR UPDATE',[id],db);if(!old)throw new HttpError(404,'Không tìm thấy chương trình.');await run('INSERT IGNORE INTO product_versions(productId,version,snapshot) VALUES (?,?,?)',[id,old.version,JSON.stringify(old)],db);await run('UPDATE products SET name=?,destination=?,duration=?,price=?,currency=?,unit=?,tier=?,validUntil=?,conditions=?,version=version+1 WHERE id=?',[data.name,data.destination,data.duration,data.price,data.currency,data.unit,data.tier,data.validUntil,data.conditions,id],db);await run("UPDATE campaigns SET status='draft',approvedAt=NULL,approvedBy=NULL WHERE productId=? AND status IN ('approved','scheduled','running','paused')",[id],db);await audit(user.id,'rate_version_created','product',id,{},db);await notify(null,'Bảng giá có phiên bản mới','Các chiến dịch liên quan cần được duyệt lại.','warning',db);});return ok();
  }
  if(resource==='templates'&&method==='POST'){
    const data=schemas.templateSchema.parse(await json(request)),entityId=randomUUID();await run('INSERT INTO templates(id,name,subject,body,category) VALUES (?,?,?,?,?)',[entityId,data.name,data.subject,data.body,data.category]);await audit(user.id,'template_created','template',entityId);await notify(null,'Đã thêm mẫu thư',data.name,'success');return ok({id:entityId});
  }
  if(resource==='templates'&&id&&method==='PATCH'){
    const data=schemas.templateSchema.parse(await json(request));await transaction(async db=>{if(!(await rows('SELECT id FROM templates WHERE id=? FOR UPDATE',[id],db)).length)throw new HttpError(404,'Không tìm thấy mẫu thư.');await run('UPDATE templates SET name=?,subject=?,body=?,category=?,version=version+1 WHERE id=?',[data.name,data.subject,data.body,data.category,id],db);await run("UPDATE campaigns SET status='draft',approvedAt=NULL,approvedBy=NULL WHERE templateId=? AND status IN ('approved','scheduled','running','paused')",[id],db);await audit(user.id,'template_updated','template',id,{},db);});return ok();
  }
  if(resource==='campaigns'&&method==='POST'){
    const data=schemas.campaignSchema.parse(await json(request)),entityId=randomUUID();const contacts=await rows(`SELECT c.*,a.ownerId FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.deletedAt IS NULL AND c.id IN (${data.contactIds.map(()=>'?').join(',')})`,data.contactIds);
    const ownerId=user.role==='admin'?(data.ownerId||user.id):user.id;
    if(contacts.length!==new Set(data.contactIds).size||contacts.some(c=>c.ownerId!==ownerId))throw new HttpError(409,'Người nhận phải thuộc cùng sale phụ trách chiến dịch.');
    if(new Set(contacts.map(c=>c.accountId)).size!==contacts.length)throw new HttpError(409,'Pilot chỉ chọn một người liên hệ mỗi đại lý trong cùng chiến dịch.');
    const conflicts=await rows(`SELECT r.id FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId JOIN contacts c ON c.id=r.contactId WHERE c.accountId IN (${contacts.map(()=>'?').join(',')}) AND (r.status IN ('sending','unknown') OR (r.status='pending' AND p.status IN ('approved','scheduled','running','paused'))) LIMIT 1`,contacts.map(c=>c.accountId));
    if(conflicts.length)throw new HttpError(409,'Đại lý đã có lượt gửi đang chờ hoặc chưa rõ kết quả trong chiến dịch khác.');
    await transaction(async db=>{await run('INSERT INTO campaigns(id,name,ownerId,templateId,productId,recipientPolicy,followupBody,followupDays) VALUES (?,?,?,?,?,?,?,?)',[entityId,data.name,ownerId,data.templateId,data.productId,data.recipientPolicy,data.followupBody,data.followupDays],db);for(const contactId of new Set(data.contactIds))await run('INSERT INTO campaign_recipients(id,campaignId,contactId) VALUES (?,?,?)',[randomUUID(),entityId,contactId],db);await audit(user.id,'campaign_created','campaign',entityId,{},db);await notify(ownerId,'Đã tạo chiến dịch nháp',data.name,'success',db);});return ok({id:entityId});
  }
  if(resource==='campaigns'&&id&&method==='GET'){
    const preview=await campaignPreview(user,id);const recipients=await rows('SELECT r.*,c.email,c.name contactName FROM campaign_recipients r JOIN contacts c ON c.id=r.contactId WHERE r.campaignId=? ORDER BY r.step,c.email',[id]);return ok({...preview,delivery:recipients});
  }
  if(resource==='campaign-test'&&id&&method==='POST'){
    requireAdmin(user);const data=z.object({email:z.email(),contactId:schemas.id}).parse(await json(request));
    const allow=(process.env.TEST_RECIPIENTS||'').split(',').map(normalizeEmail).filter(Boolean);
    if(!allow.includes(normalizeEmail(data.email)))throw new HttpError(409,'Email thử phải được cấu hình trong TEST_RECIPIENTS trên máy chủ.');
    if(!mailReady())throw new HttpError(409,'SMTP chưa sẵn sàng.');
    const preview=await campaignPreview(user,id),recipient=preview.recipients.find(r=>r.id===data.contactId);if(!recipient?.preview)throw new HttpError(409,'Không có bản xem trước hợp lệ.');
    const transport=await smtpTransport();try{await transport.sendMail({from:process.env.SMTP_FROM_EMAIL,to:data.email,subject:'[TEST] '+recipient.preview.subject,text:recipient.preview.body+'\n\nBản thử nội bộ. Không phải lượt gửi chiến dịch.'});}finally{transport.close();}
    await audit(user.id,'internal_test_sent','campaign',id,{recipient:data.email});return ok();
  }
  if(resource==='reconcile'&&id&&method==='POST'){
    requireAdmin(user);const data=z.object({result:z.enum(['accepted','not_sent']),evidence:z.string().trim().min(20).max(2000)}).parse(await json(request));
    await transaction(async db=>{const [recipient]=await rows('SELECT * FROM campaign_recipients WHERE id=? FOR UPDATE',[id],db);if(!recipient||recipient.status!=='unknown')throw new HttpError(409,'Chỉ đối soát lượt gửi chưa xác định.');
      await run('UPDATE campaign_recipients SET status=?,sentAt=IF(?=\'accepted\',COALESCE(sentAt,claimedAt),sentAt),error=? WHERE id=?',[data.result==='accepted'?'accepted':'skipped',data.result,'Đối soát: '+data.evidence,id],db);
      if(data.result==='accepted')await run('UPDATE contacts SET lastContactedAt=GREATEST(COALESCE(lastContactedAt,\'2000-01-01\'),?) WHERE id=?',[recipient.claimedAt,recipient.contactId],db);
      await audit(user.id,'send_reconciled','recipient',id,data,db);await notify(null,'Đã đối soát lượt gửi','Lượt này không được tự gửi lại.','info',db);
    });return ok();
  }
  if(resource==='validate-email'&&id&&method==='POST'){
    const [contact]=await rows('SELECT * FROM contacts WHERE id=?',[id]);if(!contact)throw new HttpError(404,'Không tìm thấy liên hệ.');await ownAccount(user,contact.accountId);
    const {Resolver}=await import('node:dns/promises'),resolver=new Resolver({timeout:2500,tries:1});let status='unknown';
    try{const records=await resolver.resolveMx(contact.email.split('@')[1]);status=records.some(r=>r.exchange&&r.exchange!=='.')?'mx_found':'no_mx';}catch(error){if(['ENODATA','ENOTFOUND'].includes((error as {code:string}).code))status='no_mx';}
    await audit(user.id,'email_dns_checked','contact',id,{status});return ok({status,message:status==='mx_found'?'Tên miền có MX. Chưa xác minh hộp thư tồn tại hoặc quyền gửi.':status==='no_mx'?'Không tìm thấy MX. Cần kiểm tra địa chỉ trước khi gửi.':'Chưa xác định được DNS. Thử lại sau.'});
  }
  if(resource==='campaigns'&&id&&method==='PATCH'){
    const campaign=await ownedCampaign(user,id);const data=z.object({action:z.enum(['approve','schedule','pause','cancel','recipient-policy']),recipientPolicy:z.enum(['eligible_only','include_unreviewed']).optional(),previewToken:z.string().length(64).optional(),acceptExclusions:z.boolean().default(false),scheduledAt:z.iso.datetime({offset:true}).optional()}).parse(await json(request));
    await transaction(async db=>{
      if(data.action==='approve'){
        // Serialize campaigns targeting the same agencies before reading approval state.
        await rows('SELECT a.id FROM accounts a WHERE a.id IN (SELECT c.accountId FROM campaign_recipients r JOIN contacts c ON c.id=r.contactId WHERE r.campaignId=?) ORDER BY a.id FOR UPDATE',[id],db);
        if(campaign.productId)await rows('SELECT id FROM products WHERE id=? FOR UPDATE',[campaign.productId],db);
        await rows('SELECT id FROM templates WHERE id=? FOR UPDATE',[campaign.templateId],db);
      }
      const current=await ownedCampaign(user,id,db,true);
      if(data.action==='recipient-policy'){
        if(!data.recipientPolicy)throw new HttpError(400,'Hãy chọn điều kiện nhận tin.');
        if(!['draft','approved','paused'].includes(current.status))throw new HttpError(409,'Tạm dừng chiến dịch trước khi đổi điều kiện.');
        if((await rows("SELECT id FROM campaign_recipients WHERE campaignId=? AND (attempts>0 OR claimedAt IS NOT NULL) LIMIT 1",[id],db)).length)throw new HttpError(409,'Chiến dịch đã có lượt xử lý. Hãy tạo chiến dịch mới để đổi điều kiện.');
        await run("UPDATE campaigns SET recipientPolicy=?,status='draft',approvedAt=NULL,approvedBy=NULL,scheduledAt=NULL WHERE id=?",[data.recipientPolicy,id],db);
        await run("UPDATE campaign_recipients SET status='pending',error=NULL,dueAt=NULL WHERE campaignId=? AND status='skipped' AND error LIKE 'Bộ lọc người nhận: %'",[id],db);
        await audit(user.id,'campaign_recipient_policy_updated','campaign',id,{before:current.recipientPolicy,after:data.recipientPolicy},db);
      }else if(data.action==='approve'){
        if(!['draft','approved','paused'].includes(current.status))throw new HttpError(409,'Trạng thái hiện tại không cho phép duyệt.');
        if((await rows("SELECT id FROM campaign_recipients WHERE campaignId=? AND status IN ('sending','unknown') LIMIT 1",[id],db)).length)throw new HttpError(409,'Cần đối soát lượt gửi trước khi duyệt lại.');
        const preview=await campaignPreview(user,id,db);
        if(data.previewToken&&data.previewToken!==preview.previewToken)throw new HttpError(409,'Danh sách hoặc nội dung đã thay đổi. Hãy tải lại kiểm tra người nhận trước khi duyệt.');
        if(!preview.eligible)throw new HttpError(409,'Không có người nhận đạt điều kiện. Xem danh sách không đạt và lý do trước khi duyệt.');
        if(preview.blocked&&(!data.acceptExclusions||!data.previewToken))throw new HttpError(409,`Có ${preview.blocked} người nhận không đạt. Hãy xem danh sách và xác nhận chỉ gửi cho ${preview.eligible} người nhận đạt điều kiện.`);
        const eligibleIds=preview.recipients.filter(r=>!r.reason).map(r=>r.id);const [conflict]=await rows(`SELECT r.id FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId JOIN contacts c ON c.id=r.contactId WHERE r.campaignId<>? AND c.accountId IN (SELECT accountId FROM contacts WHERE id IN (${eligibleIds.map(()=>'?').join(',')})) AND (r.status IN ('sending','unknown') OR (r.status='pending' AND p.status IN ('approved','scheduled','running','paused'))) LIMIT 1`,[id,...eligibleIds],db);if(conflict)throw new HttpError(409,'Đại lý đã có chiến dịch đang hoạt động.');
        // Validate follow-up variables during approval as well.
        if(current.followupBody?.trim())for(const recipient of preview.recipients.filter(r=>!r.reason))renderMail(preview.template.subject,current.followupBody,{name:recipient.name,accountName:recipient.accountName},preview.product,'Sale');
        for(const recipient of preview.recipients.filter(r=>r.reason))await run("UPDATE campaign_recipients SET status='skipped',error=? WHERE campaignId=? AND contactId=? AND step=0 AND status='pending'",['Bộ lọc người nhận: '+recipient.reason,id,recipient.id],db);
        await audit(user.id,'campaign_recipients_approved','campaign',id,{recipientPolicy:current.recipientPolicy,eligible:preview.eligible,excluded:preview.blocked,previewToken:preview.previewToken},db);
        await run("UPDATE campaigns SET status='approved',subject=?,body=?,templateVersion=?,productVersion=?,approvedBy=?,approvedAt=UTC_TIMESTAMP(3) WHERE id=?",[preview.template.subject,preview.template.body,preview.template.version,preview.product?.version??null,user.id,id],db);
      }else if(data.action==='schedule'){
        if(!['approved','paused'].includes(current.status)||!current.approvedAt)throw new HttpError(409,'Cần duyệt chiến dịch trước khi lên lịch.');
        const date=sqlDate(data.scheduledAt||new Date());await run("UPDATE campaigns SET status='scheduled',scheduledAt=? WHERE id=?",[date,id],db);await run("UPDATE campaign_recipients SET dueAt=CASE WHEN step=0 THEN ? ELSE COALESCE(dueAt,?) END WHERE campaignId=? AND status='pending'",[date,date,id],db);
      }else {
        if(['cancelled','completed'].includes(current.status))throw new HttpError(409,'Chiến dịch đã kết thúc.');
        await run('UPDATE campaigns SET status=? WHERE id=?',[data.action==='pause'?'paused':'cancelled',id],db);if(data.action==='cancel')await run("UPDATE campaign_recipients SET status='skipped',error='Chiến dịch đã hủy' WHERE campaignId=? AND status='pending'",[id],db);
      }
    });
    await audit(user.id,'campaign_'+data.action,'campaign',id);await notify(campaign.ownerId,'Đã cập nhật chiến dịch',campaign.name,'info');return ok();
  }
  if(resource==='tasks'&&method==='POST'){
    const data=schemas.taskSchema.parse(await json(request));const ownerId=user.role==='admin'?(data.ownerId||user.id):user.id;
    if(data.accountId){const account=await ownAccount(user,data.accountId);if(account.ownerId!==ownerId)throw new HttpError(409,'Công việc phải giao đúng người phụ trách đại lý.');}
    const entityId=randomUUID();await run('INSERT INTO tasks(id,title,accountId,ownerId,dueAt,priority) VALUES (?,?,?,?,?,?)',[entityId,data.title,data.accountId||null,ownerId,sqlDate(data.dueAt),data.priority]);await notify(ownerId,'Có công việc mới',data.title);return ok({id:entityId});
  }
  if(resource==='tasks'&&id&&method==='PATCH'){
    const data=z.object({status:z.enum(['open','done'])}).parse(await json(request));const [task]=await rows('SELECT * FROM tasks WHERE id=?',[id]);if(!task)throw new HttpError(404,'Không có công việc.');if(user.role!=='admin'&&task.ownerId!==user.id)throw new HttpError(403,'Không có quyền.');if(task.accountId)await ownAccount(user,task.accountId);await run('UPDATE tasks SET status=? WHERE id=?',[data.status,id]);await notify(task.ownerId,'Đã cập nhật công việc',task.title);return ok();
  }
  if(resource==='rfqs'&&method==='POST'){
    const data=schemas.rfqSchema.parse(await json(request)),account=await ownAccount(user,data.accountId),entityId=randomUUID();
    await run('INSERT INTO rfqs(id,accountId,ownerId,title,destination,departureDate,pax,budget,deadline,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',[entityId,data.accountId,account.ownerId,data.title,data.destination,data.departureDate||null,data.pax,data.budget,data.deadline||null,data.notes]);await run("UPDATE accounts SET stage='rfq' WHERE id=?",[data.accountId]);await notify(account.ownerId,'Yêu cầu báo giá mới',data.title,'success');return ok({id:entityId});
  }
  if(resource==='rfqs'&&id&&method==='PATCH'){
    const [rfq]=await rows('SELECT * FROM rfqs WHERE id=?',[id]);if(!rfq)throw new HttpError(404,'Không tìm thấy RFQ.');await ownAccount(user,rfq.accountId);
    const data=z.object({status:z.enum(['new','working','quoted','won','lost']),bookingReference:z.string().trim().max(120).default(''),revenue:z.coerce.number().nonnegative().max(1e12).default(0),grossMargin:z.coerce.number().max(1e12).min(-1e12).default(0)}).parse(await json(request));
    if(data.status==='won'&&(!data.bookingReference||data.revenue<=0))throw new HttpError(400,'Booking thắng cần mã và doanh thu.');
    await run('UPDATE rfqs SET status=?,bookingReference=?,revenue=?,grossMargin=? WHERE id=?',[data.status,data.bookingReference,data.revenue,data.grossMargin,id]);if(['won','quoted','lost'].includes(data.status))await run('UPDATE accounts SET stage=? WHERE id=?',[data.status,rfq.accountId]);await audit(user.id,'rfq_updated','rfq',id,data);await notify(rfq.ownerId,'Đã cập nhật RFQ',rfq.title);return ok();
  }
  if(resource==='quotes'&&method==='POST'){
    const data=schemas.quoteSchema.parse(await json(request)),[rfq]=await rows('SELECT * FROM rfqs WHERE id=?',[data.rfqId]);if(!rfq)throw new HttpError(404,'Không tìm thấy RFQ.');await ownAccount(user,rfq.accountId);
    const entityId=randomUUID();await transaction(async db=>{await rows('SELECT id FROM rfqs WHERE id=? FOR UPDATE',[data.rfqId],db);const [latest]=await rows("SELECT GREATEST(COALESCE(MAX(version),0),COALESCE((SELECT CAST(value AS UNSIGNED) FROM settings WHERE settingKey=?),0))+1 version FROM quotes WHERE rfqId=?",['quote_sequence_'+data.rfqId,data.rfqId],db);await setting('quote_sequence_'+data.rfqId,String(latest.version),db);await run('INSERT INTO quotes(id,rfqId,version,amount,currency,validUntil,conditions) VALUES (?,?,?,?,?,?,?)',[entityId,data.rfqId,latest.version,data.amount,data.currency,data.validUntil,data.conditions],db);await run("UPDATE rfqs SET status='quoted' WHERE id=?",[data.rfqId],db);await audit(user.id,'quote_created','quote',entityId,{rfqId:data.rfqId,version:latest.version},db);});await notify(rfq.ownerId,'Đã lưu phiên bản báo giá',rfq.title,'success');return ok({id:entityId});
  }
  if(resource==='messages'&&id&&method==='PATCH'){
    const data=z.object({classification:z.enum(['unclassified','positive','rfq','not_now','wrong_person','unsubscribe'])}).parse(await json(request));const [message]=await rows('SELECT m.*,c.accountId,c.email FROM inbound_messages m JOIN contacts c ON c.id=m.contactId WHERE m.id=?',[id]);if(!message)throw new HttpError(404,'Không tìm thấy email.');await ownAccount(user,message.accountId);
    await transaction(async db=>{await run('UPDATE inbound_messages SET classification=? WHERE id=?',[data.classification,id],db);if(data.classification==='unsubscribe')await suppress(message.email,'unsubscribe',user.id,db);await audit(user.id,'reply_classified','message',id,{classification:data.classification},db);});return ok();
  }
  if(resource==='notifications'&&method==='POST'){await run('INSERT IGNORE INTO notification_reads(notificationId,userId) SELECT id,? FROM notifications WHERE userId=? OR userId IS NULL',[user.id,user.id]);return ok();}
  if(resource==='settings'&&method==='PATCH'){
    requireAdmin(user);const data=z.object({daily_limit:z.coerce.number().int().min(1).max(100),signature:z.string().max(1000),sender_address:z.string().max(1000),emergency_stop:z.boolean()}).parse(await json(request));
    await transaction(async db=>{for(const [key,value] of Object.entries(data))await setting(key,String(value),db);await audit(user.id,'settings_updated','settings',null,{},db);await notify(null,data.emergency_stop?'Đã dừng toàn bộ lượt gửi':'Đã cập nhật cài đặt','Cấu hình được áp dụng cho lượt xử lý tiếp theo.',data.emergency_stop?'warning':'info',db);});return ok();
  }
  if(resource==='users'&&method==='POST'){
    requireAdmin(user);const data=schemas.userSchema.parse(await json(request)),entityId=randomUUID();await run('INSERT INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[entityId,data.name,data.email,await bcrypt.hash(data.password,12),data.role]);await audit(user.id,'user_created','user',entityId);return ok({id:entityId});
  }
  if(resource==='password'&&method==='POST'){
    const data=z.object({currentPassword:z.string().max(128),password:z.string().min(12).max(128)}).parse(await json(request));const [record]=await rows('SELECT passwordHash FROM users WHERE id=?',[user.id]);if(!await bcrypt.compare(data.currentPassword,record.passwordHash))throw new HttpError(400,'Mật khẩu hiện tại không đúng.');await run('UPDATE users SET passwordHash=? WHERE id=?',[await bcrypt.hash(data.password,12),user.id]);await run('DELETE FROM sessions WHERE userId=?',[user.id]);await createSession(user.id);return ok();
  }
  throw new HttpError(404,'Không tìm thấy chức năng.');
}
async function handler(request:Request,context:Context){try{return await handle(request,context);}catch(error){if(error instanceof HttpError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:error.issues.map(i=>i.message).join(' ')},{status:400});if(error instanceof SyntaxError)return NextResponse.json({error:'Dữ liệu JSON không hợp lệ.'},{status:400});const code=(error as {code?:string}).code;if(code==='ER_ROW_IS_REFERENCED_2'||code==='ER_NO_REFERENCED_ROW_2')return NextResponse.json({error:'Bản ghi đang được sử dụng hoặc đối tượng liên quan không còn tồn tại. Hãy tải lại danh sách và xử lý bản ghi liên quan trước.'},{status:409});if(code==='ER_LOCK_DEADLOCK'||code==='ER_LOCK_WAIT_TIMEOUT')return NextResponse.json({error:'Dữ liệu đang được cập nhật bởi thao tác khác. Vui lòng thử lại.'},{status:409});if(code==='ER_DUP_ENTRY')return NextResponse.json({error:'Dữ liệu đã tồn tại. Kiểm tra email hoặc bản ghi trùng.'},{status:409});console.error('API error',code|| (error as Error).name);return NextResponse.json({error:'Không xử lý được yêu cầu. Kiểm tra kết nối dữ liệu hoặc cấu hình dịch vụ.'},{status:500});}}
export {handler as GET,handler as POST,handler as PATCH,handler as DELETE};

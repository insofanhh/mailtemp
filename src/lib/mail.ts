import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
export {mailReady,smtpTransport,sendSmtpMail} from './smtp';
import {rows,run,type DB} from './db';
import {audit,notify} from './activity';
import {escapeHtml,interpolate,normalizeEmail} from './policy';
import {appOrigin} from './app-url';

export function unsubscribeToken(contactId:string) {
  const secret=process.env.UNSUBSCRIBE_SECRET;
  if(!secret||secret.length<32) throw new Error('Thiếu UNSUBSCRIBE_SECRET.');
  return contactId+'.'+createHmac('sha256',secret).update(contactId).digest('hex');
}
export function validUnsubscribeToken(token:string) {
  if(token.split('.').length!==2)return null;
  const [id,sig]=token.split('.');
  if(!id||!sig||!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9]{64}$/.test(sig))return null;
  const expected=unsubscribeToken(id).split('.')[1];
  return sig.length===expected.length && timingSafeEqual(Buffer.from(sig),Buffer.from(expected)) ? id : null;
}
export async function suppress(email:string,reason:string,actorId:string|null,db?:DB) {
  email=normalizeEmail(email);
  await run("INSERT INTO suppressions(id,email,reason,actorId) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE reason=IF(reason='manual',VALUES(reason),reason)",[randomUUID(),email,reason,actorId],db);
  await run("UPDATE contacts SET consentStatus='suppressed' WHERE email=?",[email],db);
  await run("UPDATE campaign_recipients r JOIN contacts c ON c.id=r.contactId SET r.status='skipped',r.error=? WHERE c.email=? AND r.status='pending'",[reason,email],db);
  await run("UPDATE direct_mail_recipients SET status='skipped',error=? WHERE email=? AND status='pending'",[reason,email],db);
  await audit(actorId,'suppressed','contact',email,{reason},db);
  const owners=await rows('SELECT DISTINCT a.ownerId FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE c.email=?',[email],db);
  const recipients=new Set<string>(owners.map(owner=>owner.ownerId));if(actorId)recipients.add(actorId);
  for(const recipient of recipients)await notify(recipient,'Đã cập nhật danh sách chặn','Một liên hệ đã được loại khỏi các lượt gửi chờ.','warning',db);
}
export function renderMail(subject:string,body:string,contact:Record<string,string>,product:Record<string,string|number>|null,senderName:string) {
  if(!product&&/\{\{\s*(tour_name|duration|price|unit|valid_until|conditions)\s*\}\}/.test(subject+'\n'+body))throw new Error('Mẫu thư có biến chương trình / bảng giá. Hãy chọn chương trình / bảng giá hoặc bỏ các biến đó khỏi mẫu.');
  const values={contact_name:contact.name||'anh/chị',company_name:contact.accountName,sender_name:senderName,tour_name:product?String(product.name):'',duration:product?String(product.duration):'',price:product?new Intl.NumberFormat('vi-VN').format(Number(product.price))+' '+product.currency:'',unit:product?String(product.unit):'',valid_until:product?String(product.validUntil).slice(0,10):'',conditions:product?String(product.conditions):''};
  const renderedSubject=interpolate(subject,values);
  if(/[\r\n]/.test(renderedSubject)||renderedSubject.length>490)throw new Error('Tiêu đề sau cá nhân hóa quá dài hoặc có xuống dòng.');
  return {subject:/^\[QC\]/i.test(renderedSubject)?renderedSubject:'[QC] '+renderedSubject,body:interpolate(body,values)};
}
export async function messageContent(contactId:string,body:string) {
  const unsubscribe=`${appOrigin()}/api/unsubscribe?token=${unsubscribeToken(contactId)}`;
  const settings=await rows("SELECT settingKey,value FROM settings WHERE settingKey IN ('signature','sender_address')");
  const values=Object.fromEntries(settings.map(r=>[r.settingKey,r.value]));
  const text=body+`\n\n${values.signature||''}\n${values.sender_address||''}\nTừ chối nhận email: ${unsubscribe}`;
  return {text,html:`<div style="font:15px/1.7 Arial,sans-serif;color:#21372f;white-space:pre-wrap">${escapeHtml(body)}</div><hr><p>${escapeHtml(values.signature||'')}<br>${escapeHtml(values.sender_address||'')}</p><p><a href="${escapeHtml(unsubscribe)}">Từ chối nhận email</a></p>`,headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}};
}

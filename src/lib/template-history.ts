import {createHash} from 'node:crypto';
import {rows,run,type DB} from './db';
import {normalizeEmail} from './policy';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(value:string)=>value.replace(/\r\n?/g,'\n').trim();
export function templateIdentity(subject:string,body:string,templateId:string|null=null,step=0){
  const contentKey=hash([canonical(subject),canonical(body)]);
  // A follow-up is separate only when its actual subject/body is different.
  // Comparing by content also prevents an identical follow-up repeating step 0.
  const identityId=step>0?null:templateId;
  return {templateId:identityId,contentKey,templateKey:identityId?hash(['template',identityId]):contentKey};
}
export type TemplateIdentity=ReturnType<typeof templateIdentity>;
export const TEMPLATE_ALREADY_SENT='Email này đã nhận mẫu thư này. Bật “Cho phép gửi lại mẫu đã gửi” nếu muốn gửi lại.';
export function templateHistoryReason(status:string|undefined,allowResend=false){
  if(status==='sending'||status==='unknown')return 'Mẫu thư này đang gửi hoặc chưa xác định kết quả. Cần xử lý lượt cũ trước khi gửi lại.';
  return status==='accepted'&&!allowResend?TEMPLATE_ALREADY_SENT:null;
}
export async function templateHistory(emails:string[],identity:TemplateIdentity,db?:DB,exclude?:{kind:'direct'|'campaign';id:string},context:'direct'|'campaign'=exclude?.kind||'direct'){
  const found=new Map<string,string>();if(!emails.length)return found;
  const unique=[...new Set(emails.map(normalizeEmail))],marks=unique.map(()=>'?').join(',');
  const directMatch=identity.templateId?'(b.templateKey=? OR (b.templateId IS NULL AND b.contentKey=?))':'b.contentKey=?';
  const campaignMatch=identity.templateId?'r.templateKey=?':'r.contentKey=?';
  const values=[...unique,...(identity.templateId?[identity.templateKey,identity.contentKey]:[identity.contentKey]),...(exclude?.kind==='direct'?[exclude.id]:[]),...unique,identity.templateId?identity.templateKey:identity.contentKey,...(exclude?.kind==='campaign'?[exclude.id]:[])];
  const history=await rows(`SELECT r.email,r.status FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId
    WHERE r.email IN (${marks}) AND (r.status IN ('accepted','sending') OR (r.status='unknown' AND ${context==='direct'?'r.retryAuthorizedAt IS NULL':'r.retryConsumedBy IS NULL'})) AND ${directMatch} ${exclude?.kind==='direct'?'AND r.id<>?':''}
    UNION ALL SELECT r.emailSnapshot email,r.status FROM campaign_recipients r
    WHERE r.emailSnapshot IN (${marks}) AND r.status IN ('accepted','sending','unknown') AND ${campaignMatch} ${exclude?.kind==='campaign'?'AND r.id<>?':''}`,values,db);
  for(const row of history){const email=normalizeEmail(row.email);if(!found.has(email)||row.status!=='accepted')found.set(email,row.status);}
  return found;
}

// Idempotent migration preserves existing accepted mail as duplicate evidence.
export async function backfillTemplateHistory(){
  const templates=await rows('SELECT id,subject,body FROM templates');
  const byContent=new Map<string,string[]>();
  for(const t of templates){const key=templateIdentity(t.subject,t.body).contentKey;byContent.set(key,[...(byContent.get(key)||[]),t.id]);}
  let cursor='';
  for(;;){
    const batches=await rows('SELECT id,subject,body,templateId FROM direct_mail_batches WHERE (templateKey IS NULL OR contentKey IS NULL) AND id>? ORDER BY id LIMIT 200',[cursor]);
    if(!batches.length)break;
    for(const b of batches){
      const content=templateIdentity(b.subject,b.body),matches=byContent.get(content.contentKey)||[];
      const templateId=b.templateId||(matches.length===1?matches[0]:null),identity=templateIdentity(b.subject,b.body,templateId);
      await run('UPDATE direct_mail_batches SET templateId=?,templateKey=?,contentKey=? WHERE id=?',[templateId,identity.templateKey,identity.contentKey,b.id]);
    }
    cursor=batches[batches.length-1].id;
  }
  cursor='';
  for(;;){
    const recipients=await rows(`SELECT r.id,r.step,c.email,p.templateId,COALESCE(p.subject,t.subject) subject,
      IF(r.step>0,p.followupBody,COALESCE(p.body,t.body)) body FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId
      JOIN contacts c ON c.id=r.contactId JOIN templates t ON t.id=p.templateId
      WHERE (r.templateKey IS NULL OR r.contentKey IS NULL OR r.emailSnapshot IS NULL) AND r.id>? ORDER BY r.id LIMIT 200`,[cursor]);
    if(!recipients.length)break;
    for(const r of recipients){const identity=templateIdentity(r.subject||'',r.body||'',r.templateId,r.step);await run('UPDATE campaign_recipients SET emailSnapshot=COALESCE(emailSnapshot,?),templateKey=COALESCE(templateKey,?),contentKey=COALESCE(contentKey,?) WHERE id=?',[normalizeEmail(r.email),identity.templateKey,identity.contentKey,r.id]);}
    cursor=recipients[recipients.length-1].id;
  }
}

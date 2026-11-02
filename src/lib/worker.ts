import {randomUUID} from 'node:crypto';
import {pool,rows,run,sqlDate,transaction} from './db';
import {notify,setting,audit} from './activity';
import {blockReason,insideSendingWindow} from './policy';
import {mailReady,messageContent,renderMail,sendSmtpMail} from './mail';
import {deliveryFailure} from './smtp';
import {DIRECT_SCHEDULED_BLOCK_SQL} from './direct-mail-conflicts';
import {sendOAuth,syncMailbox} from './oauth';
import {appOrigin} from './app-url';
import {templateHistory,templateHistoryReason,templateIdentity} from './template-history';

export async function claimRecipient(recipientId:string){
  return transaction(async db=>{
    const [r]=await rows('SELECT * FROM campaign_recipients WHERE id=? FOR UPDATE',[recipientId],db);if(!r||r.status!=='pending')return null;
    const [campaign]=await rows('SELECT * FROM campaigns WHERE id=? FOR UPDATE',[r.campaignId],db);
    const [contact]=await rows('SELECT c.*,a.name accountName,a.tier,a.ownerId,a.deletedAt accountDeletedAt FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE c.id=? FOR UPDATE',[r.contactId],db);
    const [product]=await rows('SELECT * FROM products WHERE id=?',[campaign.productId],db),[template]=await rows('SELECT * FROM templates WHERE id=?',[campaign.templateId],db),[sender]=await rows('SELECT name,email FROM users WHERE id=? AND active=TRUE',[campaign.ownerId],db);
    const [suppression]=await rows('SELECT id FROM suppressions WHERE email=?',[contact.email],db);
    let reason=blockReason({recipientPolicy:campaign.recipientPolicy,hasProduct:Boolean(campaign.productId),accountDeletedAt:contact.accountDeletedAt,consentStatus:contact.consentStatus,evidence:contact.consentEvidence,purpose:contact.consentPurpose,country:contact.country,suppressed:Boolean(suppression),source:contact.source,validUntil:product?.validUntil||'',tier:contact.tier,productTier:product?.tier||'',lastReplyAt:contact.lastReplyAt,approvedAt:campaign.approvedAt,lastContactedAt:contact.lastContactedAt});
    const [directConflict]=await rows(`SELECT r.id FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE r.email=? AND ${DIRECT_SCHEDULED_BLOCK_SQL} LIMIT 1`,[contact.email],db);
    if(directConflict)reason='Email này đang có lượt gửi trực tiếp hoạt động hoặc cần đối soát.';
    if(!['scheduled','running'].includes(campaign.status)||!campaign.approvedAt||campaign.productVersion!==(product?.version??null)||campaign.templateVersion!==template.version)reason='Nội dung hoặc trạng thái duyệt đã thay đổi.';
    if(!sender||contact.ownerId!==campaign.ownerId)reason='Người phụ trách đã thay đổi hoặc ngừng hoạt động.';
    const identity=templateIdentity(campaign.subject||'',(r.step>0?campaign.followupBody:campaign.body)||'',campaign.templateId,r.step);
    const history=await templateHistory([contact.email],identity,db,{kind:'campaign',id:r.id});
    reason=reason||templateHistoryReason(history.get(contact.email),!!campaign.allowTemplateResend);
    let content:null|{subject:string;body:string}=null;
    try{content=renderMail(campaign.subject,r.step>0?campaign.followupBody:campaign.body,contact,product||null,sender?.name||'');}catch(error){reason=(error as Error).message;}
    if(reason||!content){await run("UPDATE campaign_recipients SET status='skipped',error=? WHERE id=?",[reason||'Nội dung không hợp lệ',r.id],db);return null;}
    const messageId=`<${r.id}@${new URL(appOrigin()).hostname}>`;
    await run("UPDATE campaign_recipients SET status='sending',attempts=attempts+1,claimedAt=UTC_TIMESTAMP(3),messageId=?,renderedSubject=?,renderedBody=?,emailSnapshot=?,templateKey=?,contentKey=?,error=NULL WHERE id=?",[messageId,content.subject,content.body,contact.email,identity.templateKey,identity.contentKey,r.id],db);
    await run("UPDATE campaigns SET status='running' WHERE id=?",[campaign.id],db);
    return {r,campaign,contact,content,messageId,sender};
  });
}

export async function recipientDispatchBlockReason(recipientId:string,ownerId:string){
  const [gate]=await rows(`SELECT c.*,a.tier,a.ownerId,a.deletedAt accountDeletedAt,(SELECT COUNT(*) FROM suppressions s WHERE s.email=c.email) blocked,p.recipientPolicy,p.status,p.approvedAt,p.productId,p.productVersion,p.templateVersion,p.templateId,p.subject,p.body,p.followupBody,p.allowTemplateResend,r.step deliveryStep,pr.version currentProductVersion,t.version currentTemplateVersion,pr.validUntil,pr.tier productTier,u.active FROM contacts c JOIN accounts a ON a.id=c.accountId JOIN campaign_recipients r ON r.contactId=c.id JOIN campaigns p ON p.id=r.campaignId LEFT JOIN products pr ON pr.id=p.productId JOIN templates t ON t.id=p.templateId JOIN users u ON u.id=p.ownerId WHERE r.id=?`,[recipientId]);
  if(!gate)return 'Không tìm thấy dữ liệu lượt gửi.';
  const [stop]=await rows("SELECT value FROM settings WHERE settingKey='emergency_stop'");
  const policy=blockReason({recipientPolicy:gate.recipientPolicy,hasProduct:Boolean(gate.productId),accountDeletedAt:gate.accountDeletedAt,consentStatus:gate.consentStatus,evidence:gate.consentEvidence,purpose:gate.consentPurpose,country:gate.country,suppressed:Boolean(gate.blocked),source:gate.source,validUntil:gate.validUntil||'',tier:gate.tier,productTier:gate.productTier||'',lastReplyAt:gate.lastReplyAt,approvedAt:gate.approvedAt,lastContactedAt:gate.lastContactedAt});
  if(policy)return policy;
  const history=await templateHistory([gate.email],templateIdentity(gate.subject||'',(gate.deliveryStep>0?gate.followupBody:gate.body)||'',gate.templateId,gate.deliveryStep),undefined,{kind:'campaign',id:recipientId});
  const templateReason=templateHistoryReason(history.get(gate.email),!!gate.allowTemplateResend);
  if(templateReason)return templateReason;
  const [directConflict]=await rows(`SELECT r.id FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE r.email=? AND ${DIRECT_SCHEDULED_BLOCK_SQL} LIMIT 1`,[gate.email]);
  if(directConflict)return 'Email này đang có lượt gửi trực tiếp hoạt động hoặc cần đối soát.';
  const [accountReply]=await rows('SELECT id FROM contacts WHERE accountId=? AND lastReplyAt>=? LIMIT 1',[gate.accountId,gate.approvedAt]);
  if(accountReply||gate.ownerId!==ownerId||!gate.active||!gate.approvedAt||gate.productVersion!==gate.currentProductVersion||gate.templateVersion!==gate.currentTemplateVersion||!['scheduled','running'].includes(gate.status)||stop?.value==='true')return 'Trạng thái thay đổi trước dispatch';
  return null;
}

export async function runCron(){
  const lock=await pool().getConnection(),runId=randomUUID(),started=Date.now();let processed=0;
  const [locks]=await lock.query("SELECT GET_LOCK('mailtemp_cron',0) acquired");
  if(!(locks as {acquired:number}[])[0].acquired){lock.release();return {busy:true,processed:0};}
  try{
    await run('INSERT INTO cron_runs(id,status) VALUES (?,?)',[runId,'running']);
    await setting('last_cron_at',new Date().toISOString());
    await run("UPDATE campaign_recipients SET status='unknown',error='Worker gián đoạn sau khi claim; cần đối soát, không tự gửi lại' WHERE status='sending' AND claimedAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE)");
    await run('DELETE FROM sessions WHERE expiresAt<UTC_TIMESTAMP(3)');await run('DELETE FROM oauth_states WHERE expiresAt<UTC_TIMESTAMP(3)');
    const boxes=await rows('SELECT userId FROM mailboxes ORDER BY COALESCE(lastSyncAt,\'2000-01-01\') LIMIT 2');
    for(const box of boxes){if(Date.now()-started>7000)break;try{await syncMailbox(box.userId,Math.max(1000,8000-(Date.now()-started)));}catch{await run("UPDATE mailboxes SET lastError='Không đồng bộ được inbox. Sequence được giữ lại cho đến khi kết nối phục hồi.' WHERE userId=? AND provider<>'imap'",[box.userId]);}}
    const cfg=Object.fromEntries((await rows('SELECT settingKey,value FROM settings')).map(r=>[r.settingKey,r.value]));
    let blocked='';
    if(cfg.emergency_stop==='true')blocked='Đang dừng khẩn cấp.';
    else if(process.env.MAIL_ENABLED!=='true')blocked='Chưa bật gửi email (MAIL_ENABLED=false).';
    else if(!cfg.sender_address?.trim())blocked='Cần địa chỉ doanh nghiệp trong chữ ký trước khi gửi.';
    else if(!insideSendingWindow())blocked='Ngoài lịch gửi nội bộ: thứ Hai–thứ Sáu, 08:00–17:00, giờ Việt Nam.';
    if(!blocked){
      for(let i=0;i<1&&Date.now()-started<12000;i++){
        const candidates=await rows("SELECT r.id,r.campaignId,r.contactId,p.ownerId FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId WHERE r.status='pending' AND r.dueAt<=UTC_TIMESTAMP(3) AND p.status IN ('scheduled','running') ORDER BY r.dueAt LIMIT 20");
        let selected:null|typeof candidates[number]=null;
        for(const candidate of candidates){
          const [box]=await rows('SELECT provider,lastSyncAt,lastError FROM mailboxes WHERE userId=?',[candidate.ownerId]);
          if((!box||box.provider==='imap')&&!mailReady())continue;
          if(process.env.REPLY_SYNC_REQUIRED!=='false'){
            const last=box?.lastSyncAt||cfg['reply_sync_at:'+candidate.ownerId];
            const time=last?new Date(String(last).includes('T')?last:String(last)+'Z').getTime():0;
            if(box?.lastError||Date.now()-time>Number(process.env.REPLY_SYNC_MAX_AGE_MINUTES||10)*60000)continue;
          }
          const [count]=await rows("SELECT COUNT(*) count FROM campaign_recipients r JOIN campaigns p ON p.id=r.campaignId WHERE p.ownerId=? AND r.claimedAt>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR) AND r.status IN ('accepted','sending','unknown')",[candidate.ownerId]);
          if(Number(count.count)>=Number(cfg.daily_limit||20))continue;
          const [recent]=await rows("SELECT id FROM campaign_recipients WHERE campaignId IN (SELECT id FROM campaigns WHERE ownerId=?) AND claimedAt>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 60 SECOND) AND status IN ('accepted','sending','unknown') LIMIT 1",[candidate.ownerId]);
          if(recent)continue;selected=candidate;break;
        }
        if(!selected)break;
        const claim=await claimRecipient(selected.id);
        if(!claim)continue;
        try{
          const dispatchReason=await recipientDispatchBlockReason(claim.r.id,claim.campaign.ownerId);
          if(dispatchReason){await run("UPDATE campaign_recipients SET status='skipped',error=? WHERE id=?",[dispatchReason,claim.r.id]);continue;}
          const content=await messageContent(claim.contact.id,claim.content.body);
          const [box]=await rows('SELECT id,provider,email FROM mailboxes WHERE userId=?',[claim.campaign.ownerId]);
          if(box&&box.provider!=='imap')await sendOAuth(claim.campaign.ownerId,claim.contact.email,claim.content.subject,content.text,claim.messageId,content.headers);
          else await sendSmtpMail({from:{name:claim.sender.name,address:process.env.SMTP_FROM_EMAIL!},replyTo:process.env.SMTP_REPLY_TO||box?.email||claim.sender.email,to:claim.contact.email,subject:claim.content.subject,messageId:claim.messageId,...content});
          await transaction(async db=>{
            await run("UPDATE campaign_recipients SET status='accepted',sentAt=UTC_TIMESTAMP(3) WHERE id=?",[claim.r.id],db);await run('UPDATE contacts SET lastContactedAt=UTC_TIMESTAMP(3) WHERE id=?',[claim.contact.id],db);
            await run("UPDATE accounts SET stage='contacted' WHERE id=? AND stage IN ('new','qualified','eligible')",[claim.contact.accountId],db);
            if(claim.r.step===0&&claim.campaign.followupBody?.trim())await run('INSERT IGNORE INTO campaign_recipients(id,campaignId,contactId,step,dueAt) VALUES (?,?,?,?,?)',[randomUUID(),claim.campaign.id,claim.contact.id,1,sqlDate(new Date(Date.now()+claim.campaign.followupDays*86400000))],db);
            await audit(claim.campaign.ownerId,'mail_accepted','recipient',claim.r.id,{},db);await notify(claim.campaign.ownerId,'Email đã được nhà cung cấp chấp nhận',claim.contact.accountName,'success',db);
          });processed++;
        }catch(error){
          const failure=deliveryFailure(error);
          await run('UPDATE campaign_recipients SET status=?,error=? WHERE id=?',[failure.status,failure.message,claim.r.id]);
          await notify(claim.campaign.ownerId,failure.status==='failed'?'Gửi chiến dịch có lỗi':'Cần đối soát một lượt gửi',failure.message,'warning');
        }
      }
      await run("UPDATE campaigns p SET status='completed' WHERE p.status IN ('running','scheduled') AND NOT EXISTS(SELECT 1 FROM campaign_recipients r WHERE r.campaignId=p.id AND r.status IN ('pending','sending','unknown'))");
    }
    await run('UPDATE cron_runs SET status=?,processed=?,details=?,finishedAt=UTC_TIMESTAMP(3) WHERE id=?',[blocked?'idle':'success',processed,blocked||'Đã đồng bộ và xử lý lượt gửi đủ điều kiện.',runId]);
    return {processed,blocked:blocked||null};
  }catch(error){await run("UPDATE cron_runs SET status='failed',details='Lỗi xử lý; xem log máy chủ',finishedAt=UTC_TIMESTAMP(3) WHERE id=?",[runId]);throw error;}
  finally{await lock.query("SELECT RELEASE_LOCK('mailtemp_cron')");lock.release();}
}

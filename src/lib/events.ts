import {randomUUID} from 'node:crypto';
import {transaction,run,rows,sqlDate,type DB} from './db';
import {notify,setting} from './activity';
import {suppress} from './mail';
import {normalizeEmail} from './policy';
export type MailEvent={eventId:string;type:'reply'|'delivered'|'hard_bounce'|'complaint'|'unsubscribe'|'ooo'|'heartbeat';email?:string;messageId?:string;subject?:string;body?:string;userId?:string;receivedAt?:string};
export async function acceptEvent(event:MailEvent,db:DB) {
  const inserted=await run('INSERT IGNORE INTO webhook_events(eventId,type) VALUES (?,?)',[event.eventId,event.type],db);
  if(!inserted.affectedRows)return {duplicate:true};
  if(event.type==='heartbeat') {
    if(!event.userId)throw new Error('Heartbeat cần userId.');
    await setting('reply_sync_at:'+event.userId,new Date().toISOString(),db);return {duplicate:false};
  }
  if(!event.email)throw new Error('Thiếu email.');
  const [contact]=await rows('SELECT c.*,a.ownerId,a.name accountName FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE c.email=?',[normalizeEmail(event.email)],db);
  if(!contact)return {ignored:true};
  if(event.userId&&event.userId!==contact.ownerId)return {ignored:true};
  if(['hard_bounce','complaint','unsubscribe'].includes(event.type))await suppress(event.email,event.type,null,db);
  else if(event.type==='delivered'&&event.messageId)await run('UPDATE campaign_recipients SET deliveredAt=UTC_TIMESTAMP(3) WHERE messageId=? AND contactId=?',[event.messageId,contact.id],db);
  else if(event.type==='ooo') {
    await run("UPDATE campaign_recipients SET dueAt=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 3 DAY),error='OOO: đã tạm hoãn 3 ngày' WHERE contactId=? AND status='pending'",[contact.id],db);
  } else if(event.type==='reply') {
    await run('INSERT INTO inbound_messages(id,contactId,subject,body,receivedAt) VALUES (?,?,?,?,?)',[randomUUID(),contact.id,event.subject||'Phản hồi mới',event.body||'',sqlDate(event.receivedAt||new Date())],db);
    await run('UPDATE contacts SET lastReplyAt=UTC_TIMESTAMP(3) WHERE id=?',[contact.id],db);
    await run("UPDATE campaign_recipients r JOIN contacts c ON c.id=r.contactId SET r.status='skipped',r.error='Đại lý đã phản hồi',r.repliedAt=UTC_TIMESTAMP(3) WHERE c.accountId=? AND r.status='pending'",[contact.accountId],db);
    await run('UPDATE campaign_recipients SET repliedAt=UTC_TIMESTAMP(3) WHERE contactId=? AND sentAt IS NOT NULL',[contact.id],db);
    await run("UPDATE accounts SET stage='replied' WHERE id=? AND stage NOT IN ('won','quoted')",[contact.accountId],db);
    await run('INSERT INTO tasks(id,title,accountId,ownerId,dueAt,priority) VALUES (?,?,?,?,UTC_TIMESTAMP(3),?)',[randomUUID(),'Trả lời '+contact.accountName,contact.accountId,contact.ownerId,'high'],db);
    await notify(contact.ownerId,'Đại lý vừa phản hồi',contact.accountName+' · '+(event.subject||'Email mới'),'reply',db);
  }
  return {duplicate:false};
}
export async function processEvent(event:MailEvent) {return transaction(db=>acceptEvent(event,db));}

import {rows} from './db';
import {mailReady} from './mail';
import {oauthConfigured} from './oauth';
import type {User} from './auth';

export async function workspace(user:User){
  const admin=user.role==='admin', scope="a.deletedAt IS NULL"+(admin?'':' AND a.ownerId=?'), args=admin?[]:[user.id];
  const [accounts,contacts,products,templates,campaigns,tasks,rfqs,quotes,messages,users,notifications,suppressions,audit,settings,mailboxes,cronRuns,imports]=await Promise.all([
    rows(`SELECT a.*,u.name ownerName,(SELECT COUNT(*) FROM contacts c WHERE c.accountId=a.id) contactCount FROM accounts a JOIN users u ON u.id=a.ownerId WHERE ${scope} ORDER BY a.createdAt DESC`,args),
    rows(`SELECT c.*,a.name accountName,a.ownerId,a.tier FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE ${scope} ORDER BY c.createdAt DESC`,args),
    rows('SELECT * FROM products ORDER BY createdAt DESC'),rows('SELECT * FROM templates ORDER BY createdAt DESC'),
    rows(`SELECT c.*,u.name ownerName,t.name templateName,p.name productName,(SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaignId=c.id AND r.step=0) recipientCount,(SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaignId=c.id AND r.status='accepted') acceptedCount,(SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaignId=c.id AND r.repliedAt IS NOT NULL AND r.step=0) replyCount FROM campaigns c JOIN users u ON u.id=c.ownerId JOIN templates t ON t.id=c.templateId LEFT JOIN products p ON p.id=c.productId ${admin?'':'WHERE c.ownerId=?'} ORDER BY c.createdAt DESC`,args),
    rows(`SELECT t.*,a.name accountName,u.name ownerName FROM tasks t LEFT JOIN accounts a ON a.id=t.accountId JOIN users u ON u.id=t.ownerId WHERE (t.accountId IS NULL OR a.deletedAt IS NULL) ${admin?'':'AND t.ownerId=?'} ORDER BY t.status,t.dueAt`,args),
    rows(`SELECT r.*,a.name accountName FROM rfqs r JOIN accounts a ON a.id=r.accountId WHERE ${scope} ORDER BY r.createdAt DESC`,args),
    rows(`SELECT q.* FROM quotes q JOIN rfqs r ON r.id=q.rfqId JOIN accounts a ON a.id=r.accountId WHERE ${scope} ORDER BY q.createdAt DESC`,args),
    rows(`SELECT m.*,c.name contactName,c.email,a.name accountName,a.ownerId,c.accountId FROM inbound_messages m JOIN contacts c ON c.id=m.contactId JOIN accounts a ON a.id=c.accountId WHERE ${scope} ORDER BY m.receivedAt DESC LIMIT 200`,args),
    rows('SELECT id,name,email,role,active FROM users ORDER BY role,name'),
    rows('SELECT n.id,n.userId,n.title,n.body,n.kind,n.createdAt,nr.readAt FROM notifications n LEFT JOIN notification_reads nr ON nr.notificationId=n.id AND nr.userId=? WHERE n.userId=? OR n.userId IS NULL ORDER BY n.id DESC LIMIT 40',[user.id,user.id]),
    admin?rows('SELECT * FROM suppressions ORDER BY createdAt DESC LIMIT 500'):rows('SELECT s.id,s.email,s.reason,s.createdAt FROM suppressions s JOIN contacts c ON c.email=s.email JOIN accounts a ON a.id=c.accountId WHERE a.ownerId=?',[user.id]),
    rows(`SELECT l.*,u.name actorName FROM audit_logs l LEFT JOIN users u ON u.id=l.actorId ${admin?'':'WHERE l.actorId=?'} ORDER BY l.createdAt DESC LIMIT 60`,args),
    rows('SELECT settingKey,value,updatedAt FROM settings'),
    rows(`SELECT id,userId,provider,email,lastSyncAt,lastError FROM mailboxes ${admin?'':'WHERE userId=?'}`,args),
    admin?rows('SELECT * FROM cron_runs ORDER BY startedAt DESC LIMIT 10'):Promise.resolve([]),
    rows(`SELECT * FROM import_batches ${admin?'':'WHERE actorId=?'} ORDER BY createdAt DESC LIMIT 20`,args)
  ]);
  return {serverTime:new Date().toISOString(),user,accounts,contacts,products,templates,campaigns,tasks,rfqs,quotes,messages,users,notifications,suppressions,audit,settings:Object.fromEntries(settings.map(s=>[s.settingKey,s.value])),mailboxes,cronRuns,imports,infrastructure:{smtpConfigured:Boolean(process.env.SMTP_HOST&&process.env.SMTP_FROM_EMAIL),smtpEnabled:mailReady(),mailEnabled:process.env.MAIL_ENABLED==='true',googleConfigured:oauthConfigured('google'),microsoftConfigured:oauthConfigured('microsoft'),appUrl:process.env.APP_URL||'http://localhost:3000',cronConfigured:Boolean(process.env.CRON_SECRET&&process.env.CRON_SECRET.length>=32),replySyncRequired:process.env.REPLY_SYNC_REQUIRED!=='false'}};
}

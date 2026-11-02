import {z} from 'zod';
import {HttpError,type User} from './auth';
import {rows,run,transaction} from './db';
import {audit,notify} from './activity';

export async function bulkDeleteContacts(user:User,body:unknown){
  const {ids:input}=z.object({ids:z.array(z.uuid()).min(1).max(100)}).strict().parse(body);
  const ids=[...new Set(input)].sort(),marks=ids.map(()=>'?').join(',');
  return transaction(async db=>{
    // Lock each explicit contact (and its account) before checking dependencies.
    // FK inserts referencing these contacts wait until this transaction completes.
    const contacts=await rows(`SELECT c.id,c.name,c.email,a.ownerId FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.deletedAt IS NULL AND c.id IN (${marks}) ORDER BY c.id FOR UPDATE`,ids,db);
    if(user.role!=='admin'&&contacts.some(contact=>contact.ownerId!==user.id))throw new HttpError(403,'Danh sách chọn có liên hệ không thuộc quyền phụ trách của bạn. Chưa xóa dữ liệu nào.');
    const campaigns=new Set((await rows(`SELECT DISTINCT contactId FROM campaign_recipients WHERE contactId IN (${marks})`,ids,db)).map(item=>item.contactId));
    const replies=new Set((await rows(`SELECT DISTINCT contactId FROM inbound_messages WHERE contactId IN (${marks})`,ids,db)).map(item=>item.contactId));
    const skipped=contacts.filter(contact=>campaigns.has(contact.id)||replies.has(contact.id)).map(contact=>({id:String(contact.id),name:String(contact.name),email:String(contact.email),reason:[campaigns.has(contact.id)?'Đang có trong chiến dịch; cần giữ lịch sử gửi.':'',replies.has(contact.id)?'Còn thư phản hồi liên quan.':''].filter(Boolean).join(' ')}));
    const eligible=contacts.filter(contact=>!campaigns.has(contact.id)&&!replies.has(contact.id));
    if(eligible.length){
      const removable=eligible.map(contact=>String(contact.id)),placeholders=removable.map(()=>'?').join(',');
      await run(`DELETE FROM consent_events WHERE contactId IN (${placeholders})`,removable,db);
      await run(`DELETE FROM contacts WHERE id IN (${placeholders})`,removable,db);
      // Accounts and email-based suppressions are deliberately preserved.
      await audit(user.id,'contacts_bulk_deleted','contact',null,{contacts:eligible.map(contact=>({id:contact.id,name:contact.name,email:contact.email})),skipped:skipped.map(contact=>contact.id)},db);
      const recipients=new Set<string>([user.id,...eligible.map(contact=>String(contact.ownerId))]);
      for(const recipient of recipients)await notify(recipient,'Đã xóa liên hệ hàng loạt',`Đã xóa ${eligible.length} liên hệ; bỏ qua ${skipped.length} liên hệ có dữ liệu liên quan.`,'info',db);
    }
    return {deleted:eligible.length,skipped,missing:ids.length-contacts.length};
  });
}

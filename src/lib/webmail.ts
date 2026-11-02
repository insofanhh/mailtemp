import {createHash,randomUUID} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {pool,rows,run,sqlDate,transaction} from './db';
import {encrypt,decrypt} from './credentials';
import {HttpError,type User} from './auth';
import {audit} from './activity';
import {processEvent,type MailEvent} from './events';
import {webmailSchema,type WebmailInput} from './webmail-schema';
import {withWebmail,webmailError} from './webmail-client';

// The session injection is for in-process tests only; API clients cannot select a transport.
export async function connectWebmail(user:User,raw:unknown,session=withWebmail){
  const input=webmailSchema.parse(raw);
  if(!process.env.TOKEN_ENCRYPTION_KEY||process.env.TOKEN_ENCRYPTION_KEY.length<32)throw new HttpError(503,'Quản trị viên cần cấu hình TOKEN_ENCRYPTION_KEY trước khi kết nối Webmail.');
  if((await rows('SELECT id FROM mailboxes WHERE userId=?',[user.id])).length)throw new HttpError(409,'Hãy ngắt kết nối hộp thư hiện tại trước khi kết nối Webmail.');
  // Encrypt before connecting so a missing encryption key cannot leave a saved plaintext secret.
  const passwordEncrypted=encrypt(input.password);
  try{await session(input,18000,async client=>{await client.mailboxOpen('INBOX',{readOnly:true});});}
  catch(error){throw new HttpError(422,webmailError(error));}
  await transaction(async db=>{
    await rows('SELECT id FROM users WHERE id=? FOR UPDATE',[user.id],db);
    if((await rows('SELECT id FROM mailboxes WHERE userId=?',[user.id],db)).length)throw new HttpError(409,'Hộp thư đã được kết nối ở lượt khác. Hãy tải lại trang.');
    const id=randomUUID();
    await run("INSERT INTO mailboxes(id,userId,provider,email,accessToken,refreshToken,expiresAt) VALUES (?,?,'imap',?,'','',UTC_TIMESTAMP(3))",[id,user.id,input.email],db);
    await run('INSERT INTO webmail_connections(mailboxId,host,port,username,passwordEncrypted,sinceAt) VALUES (?,?,?,?,?,?)',[id,input.host,input.port,input.username,passwordEncrypted,sqlDate(new Date(Date.now()-7*86400000))],db);
    await audit(user.id,'webmail_connected','mailbox',id,{host:input.host,email:input.email},db);
  });
  return {ok:true};
}

export async function webmailEvent(userId:string,boxEmail:string,validity:string,uid:number,raw:Buffer,receivedAt:Date,fallback:{email:string;subject?:string}):Promise<MailEvent|null>{
  const mail=await simpleParser(raw,{skipHtmlToText:false,skipTextToHtml:true,skipImageLinks:true});
  const email=(mail.from?.value[0]?.address||fallback.email).toLowerCase();
  if(email===boxEmail.toLowerCase())return null;
  const auto=String(mail.headers.get('auto-submitted')||'').trim().toLowerCase();
  const automated=!!(auto&&auto!=='no')||!!mail.headers.get('x-autoreply')||!!mail.headers.get('x-autorespond');
  const identity=mail.messageId||`${boxEmail}:${validity}:${uid}`;
  return {eventId:`imap:${userId}:${createHash('sha256').update(identity).digest('hex')}`,userId,type:automated?'ooo':'reply',email,subject:(mail.subject||fallback.subject||'Phản hồi').slice(0,500),body:(mail.text||'').slice(0,100000),receivedAt:receivedAt.toISOString()};
}

export async function syncWebmail(userId:string,budgetMs=18000,session=withWebmail){
  const lock=await pool().getConnection(),key='webmail:'+userId;
  let acquired=false;
  try{
    const [locks]=await lock.query('SELECT GET_LOCK(?,0) acquired',[key]);
    acquired=!!(locks as {acquired:number}[])[0].acquired;
    if(!acquired)throw new HttpError(409,webmailError({code:'WEBMAIL_BUSY'}));
    const [box]=await rows("SELECT b.id,b.email,w.* FROM mailboxes b JOIN webmail_connections w ON w.mailboxId=b.id WHERE b.userId=? AND b.provider='imap'",[userId]);
    if(!box)return 0;
    let processed=0;
    const syncStarted=sqlDate(new Date()),deadline=Date.now()+budgetMs;
    try{
      const input:WebmailInput={email:box.email,host:box.host,port:box.port,username:box.username,password:decrypt(box.passwordEncrypted)};
      await session(input,budgetMs,async client=>{
        const inbox=await client.mailboxOpen('INBOX',{readOnly:true}),validity=String(inbox.uidValidity);
        let cursor=box.uidValidity===validity?Number(box.lastUid):0;
        await run('UPDATE webmail_connections SET uidValidity=?,lastUid=? WHERE mailboxId=?',[validity,cursor,box.id]);
        const since=new Date(String(box.sinceAt)+'Z');
        const matches=await client.search({since,uid:`${cursor+1}:*`},{uid:true});
        const ids=(matches||[]).filter(uid=>uid>cursor).sort((a,b)=>a-b);
        const contacts=await rows('SELECT c.email FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.ownerId=? AND a.deletedAt IS NULL',[userId]);
        const known=new Set(contacts.map(contact=>String(contact.email).toLowerCase()));
        for(const uid of ids.slice(0,200)){
          if(Date.now()>deadline-500)throw Object.assign(new Error('WEBMAIL_BACKLOG'),{code:'WEBMAIL_BACKLOG'});
          const message=await client.fetchOne(String(uid),{envelope:true,internalDate:true},{uid:true});
          if(message){
            const email=(message.envelope?.from?.[0]?.address||'').toLowerCase();
            if(known.has(email)&&email!==String(box.email).toLowerCase()){
              const full=await client.fetchOne(String(uid),{source:{start:0,maxLength:262144}},{uid:true});
              if(full&&!full.source)throw new Error('IMAP không trả nội dung thư.');
              // A disappearance between SEARCH and FETCH is normal when another client removes mail.
              if(full&&full.source){
                const event=await webmailEvent(userId,box.email,validity,uid,full.source,message.internalDate instanceof Date?message.internalDate:new Date(),{email,subject:message.envelope?.subject});
                if(event&&known.has(event.email||'')){
                  const result=await processEvent(event);
                  if(!result.duplicate&&!('ignored' in result))processed++;
                }
              }
            }
          }
          cursor=uid;
          await run('UPDATE webmail_connections SET lastUid=? WHERE mailboxId=?',[cursor,box.id]);
        }
        if(ids.length>200||Date.now()>=deadline)throw Object.assign(new Error('WEBMAIL_BACKLOG'),{code:'WEBMAIL_BACKLOG'});
        await run('UPDATE mailboxes SET lastSyncAt=?,lastError=NULL WHERE id=? AND userId=?',[syncStarted,box.id,userId]);
      });
      return processed;
    }catch(error){
      const message=webmailError(error);
      await run('UPDATE mailboxes SET lastError=? WHERE id=?',[message,box.id]);
      throw new HttpError(422,message);
    }
  }finally{
    try{if(acquired)await lock.query('SELECT RELEASE_LOCK(?)',[key]);}finally{lock.release();}
  }
}

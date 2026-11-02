import {randomBytes,randomUUID} from 'node:crypto';
import {encrypt,decrypt} from './credentials';
import {syncWebmail} from './webmail';
import {rows,run,sqlDate,transaction} from './db';
import {HttpError,hash,type User} from './auth';
import {processEvent} from './events';
import type {RowDataPacket} from 'mysql2/promise';
import {appOrigin} from './app-url';

type Provider='google'|'microsoft';
type TokenResponse={access_token:string;refresh_token?:string;expires_in:number};
export function oauthConfigured(provider:Provider){return Boolean(provider==='google'?process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET:process.env.MICROSOFT_CLIENT_ID&&process.env.MICROSOFT_CLIENT_SECRET);}
function config(provider:Provider){
  const tenant=encodeURIComponent(process.env.MICROSOFT_TENANT||'common');
  return provider==='google'?{clientId:process.env.GOOGLE_CLIENT_ID!,secret:process.env.GOOGLE_CLIENT_SECRET!,authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'}:{clientId:process.env.MICROSOFT_CLIENT_ID!,secret:process.env.MICROSOFT_CLIENT_SECRET!,authorize:`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,token:`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,scope:'offline_access User.Read Mail.Read Mail.Send'};
}
function redirectUri(provider:Provider){return `${appOrigin()}/api/oauth/${provider}/callback`;}
async function fetchJson(url:string,options?:RequestInit){const response=await fetch(url,{...options,signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});if(!response.ok)throw new Error(`Dịch vụ email trả về HTTP ${response.status}.`);return response.json();}
export async function oauthStart(provider:Provider,user:User){
  if(!oauthConfigured(provider))throw new HttpError(409,'Chưa cấu hình OAuth client cho nhà cung cấp này.');
  const cfg=config(provider),state=randomBytes(32).toString('hex');
  await run('INSERT INTO oauth_states(stateHash,userId,provider,expiresAt) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))',[hash(state),user.id,provider]);
  const url=new URL(cfg.authorize);url.search=new URLSearchParams({client_id:cfg.clientId,redirect_uri:redirectUri(provider),response_type:'code',scope:cfg.scope,state,...(provider==='google'?{access_type:'offline',prompt:'consent'}:{})}).toString();return url.toString();
}
export async function oauthCallback(provider:Provider,user:User,code:string,state:string){
  const consumed=await run('DELETE FROM oauth_states WHERE stateHash=? AND userId=? AND provider=? AND expiresAt>UTC_TIMESTAMP(3)',[hash(state),user.id,provider]);
  if(!consumed.affectedRows)throw new HttpError(400,'Phiên kết nối đã hết hạn hoặc không hợp lệ.');
  const cfg=config(provider),data:TokenResponse=await fetchJson(cfg.token,{method:'POST',body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.secret,code,grant_type:'authorization_code',redirect_uri:redirectUri(provider)})});
  if(!data.refresh_token)throw new HttpError(409,'Nhà cung cấp không cấp refresh token. Hãy kết nối lại và cấp quyền offline.');
  const refreshToken=data.refresh_token;
  const profile=await fetchJson(provider==='google'?'https://gmail.googleapis.com/gmail/v1/users/me/profile':'https://graph.microsoft.com/v1.0/me',{headers:{Authorization:'Bearer '+data.access_token}});
  const email=provider==='google'?profile.emailAddress:(profile.mail||profile.userPrincipalName);
  await transaction(async db=>{
    await rows('SELECT id FROM users WHERE id=? FOR UPDATE',[user.id],db);
    const [existing]=await rows('SELECT provider FROM mailboxes WHERE userId=?',[user.id],db);
    if(existing&&existing.provider!==provider)throw new HttpError(409,'Hãy ngắt kết nối hộp thư hiện tại trước khi đổi nhà cung cấp.');
    await run('INSERT INTO mailboxes(id,userId,provider,email,accessToken,refreshToken,expiresAt) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider=VALUES(provider),email=VALUES(email),accessToken=VALUES(accessToken),refreshToken=VALUES(refreshToken),expiresAt=VALUES(expiresAt),lastSyncAt=NULL,lastError=NULL',[randomUUID(),user.id,provider,email,encrypt(data.access_token),encrypt(refreshToken),sqlDate(new Date(Date.now()+data.expires_in*1000))],db);
  });
}
export async function accessToken(userId:string,signal?:AbortSignal):Promise<(RowDataPacket & {token:string})|null>{
  const [box]=await rows('SELECT * FROM mailboxes WHERE userId=?',[userId]);if(!box)return null;
  if(!['google','microsoft'].includes(box.provider))throw new Error('Hộp thư này không dùng OAuth.');
  if(new Date(box.expiresAt+'Z').getTime()>Date.now()+60000)return {...box,token:decrypt(box.accessToken)};
  const cfg=config(box.provider),data:TokenResponse=await fetchJson(cfg.token,{method:'POST',signal,body:new URLSearchParams({client_id:cfg.clientId,client_secret:cfg.secret,refresh_token:decrypt(box.refreshToken),grant_type:'refresh_token'})});
  await run('UPDATE mailboxes SET accessToken=?,refreshToken=?,expiresAt=? WHERE id=?',[encrypt(data.access_token),data.refresh_token?encrypt(data.refresh_token):box.refreshToken,sqlDate(new Date(Date.now()+data.expires_in*1000)),box.id]);
  return {...box,token:data.access_token};
}
export async function syncMailbox(userId:string,budgetMs=18000){
  const [provider]=await rows('SELECT provider FROM mailboxes WHERE userId=?',[userId]);
  if(provider?.provider==='imap')return syncWebmail(userId,budgetMs);
  const deadline=Date.now()+budgetMs,signal=AbortSignal.timeout(budgetMs),syncStarted=sqlDate(new Date());
  const box=await accessToken(userId,signal);if(!box)return 0;
  let processed=0;
  const auth={Authorization:'Bearer '+box.token};
  const contacts=await rows('SELECT c.email FROM contacts c JOIN accounts a ON a.id=c.accountId WHERE a.ownerId=?',[userId]);
  const known=new Set(contacts.map(c=>String(c.email).toLowerCase()));
  const [oldest]=await rows("SELECT MIN(approvedAt) approvedAt FROM campaigns WHERE ownerId=? AND status IN ('approved','scheduled','running','paused')",[userId]);
  const baseline=oldest?.approvedAt?new Date(oldest.approvedAt+'Z').getTime():Date.now()-7*86400000;
  const since=new Date(box.lastSyncAt?new Date(box.lastSyncAt+'Z').getTime()-120000:Math.min(baseline,Date.now()-86400000));
  // A bounded first sync and overlap make retries idempotent without ingesting unrelated mail.
  if(box.provider==='google'){
    let pageToken='';let pages=0;
    do {
      const query=new URLSearchParams({q:`after:${Math.floor(since.getTime()/1000)}`,maxResults:'100',...(pageToken?{pageToken}:{})});
      const page=await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?'+query,{headers:auth,signal});
      for(const entry of page.messages||[]){
        if(Date.now()>=deadline)throw new Error('Hết thời gian đồng bộ; chưa cho phép gửi.');
        const message=await fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${entry.id}?format=metadata`,{headers:auth,signal});
        const headers:Record<string,string>=Object.fromEntries((message.payload?.headers||[]).map((h:{name:string;value:string})=>[h.name.toLowerCase(),h.value]));
        const email=(headers.from?.match(/<([^>]+)>/)?.[1]||headers.from||'').trim().toLowerCase();
        if(!known.has(email)||email===String(box.email).toLowerCase())continue;
        const ooo=Boolean(headers['auto-submitted']&&headers['auto-submitted']!=='no');
        await processEvent({eventId:`google:${box.id}:${entry.id}`,type:ooo?'ooo':'reply',email,subject:headers.subject||'Phản hồi',body:message.snippet||'',userId,receivedAt:new Date(Number(message.internalDate)).toISOString()});processed++;
      }
      pageToken=page.nextPageToken||'';
      if(++pages>=3&&pageToken)throw new Error('Inbox cần đồng bộ nhiều trang; hãy kết nối adapter chuyên dụng trước khi chạy sequence.');
    }while(pageToken);
  }else{
    let url='https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?'+new URLSearchParams({'$filter':`receivedDateTime ge ${since.toISOString()}`,'$top':'100','$select':'id,subject,bodyPreview,from,receivedDateTime,internetMessageHeaders'});let pages=0;
    while(url){
      const page=await fetchJson(url,{headers:auth,signal});
      for(const message of page.value||[]){
        if(Date.now()>=deadline)throw new Error('Hết thời gian đồng bộ; chưa cho phép gửi.');
        const email=String(message.from?.emailAddress?.address||'').toLowerCase();if(!known.has(email)||email===String(box.email).toLowerCase())continue;
        const auto=message.internetMessageHeaders?.find((h:{name:string})=>h.name.toLowerCase()==='auto-submitted')?.value;
        await processEvent({eventId:`microsoft:${box.id}:${message.id}`,type:auto&&auto!=='no'?'ooo':'reply',email,subject:message.subject||'Phản hồi',body:message.bodyPreview||'',userId,receivedAt:message.receivedDateTime});processed++;
      }
      url=page['@odata.nextLink']||'';if(++pages>=3&&url)throw new Error('Inbox quá nhiều trang để đồng bộ trong một lượt.');
      if(url&&!url.startsWith('https://graph.microsoft.com/'))throw new Error('URL phân trang không hợp lệ.');
    }
  }
  await run('UPDATE mailboxes SET lastSyncAt=?,lastError=NULL WHERE id=?',[syncStarted,box.id]);return processed;
}
export async function sendOAuth(userId:string,to:string,subject:string,text:string,messageId:string,headers:Record<string,string>){
  const signal=AbortSignal.timeout(12000),box=await accessToken(userId,signal);if(!box)throw new Error('Không có mailbox OAuth.');
  if(box.provider==='google'){
    const clean=(s:string)=>s.replace(/[\r\n]/g,' ');
    const raw=[`From: ${clean(box.email)}`,`To: ${clean(to)}`,`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,`Message-ID: ${messageId}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64',...Object.entries(headers).map(([key,value])=>`${key}: ${clean(value)}`),'',Buffer.from(text).toString('base64')].join('\r\n');
    await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',signal,headers:{Authorization:'Bearer '+box.token,'Content-Type':'application/json'},body:JSON.stringify({raw:Buffer.from(raw).toString('base64url')})});
  }else{
    const response=await fetch('https://graph.microsoft.com/v1.0/me/sendMail',{method:'POST',headers:{Authorization:'Bearer '+box.token,'Content-Type':'application/json'},signal,body:JSON.stringify({message:{subject,body:{contentType:'Text',content:text},toRecipients:[{emailAddress:{address:to}}],internetMessageHeaders:[{name:'x-mailtemp-message-id',value:messageId}]},saveToSentItems:true})});
    if(!response.ok)throw new Error(`Microsoft gửi trả về HTTP ${response.status}.`);
  }
}

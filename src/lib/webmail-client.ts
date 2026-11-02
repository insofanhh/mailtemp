import {lookup} from 'node:dns/promises';
import type {LookupAddress,LookupAllOptions} from 'node:dns';
import {BlockList,isIP} from 'node:net';
import {ImapFlow} from 'imapflow';
import type {WebmailInput} from './webmail-schema';

const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)blocked.addSubnet(address,prefix,'ipv4');
const ipv6Global=new BlockList();ipv6Global.addSubnet('2000::',3,'ipv6');
const ipv6Blocked=new BlockList();
ipv6Blocked.addSubnet('2001::',23,'ipv6');ipv6Blocked.addSubnet('2001:db8::',32,'ipv6');ipv6Blocked.addSubnet('2002::',16,'ipv6');
export function publicMailAddress(address:string){
  return isIP(address)===4?!blocked.check(address,'ipv4'):isIP(address)===6&&ipv6Global.check(address,'ipv6')&&!ipv6Blocked.check(address,'ipv6');
}
export async function publicMailHost(host:string,resolve:(host:string,options:LookupAllOptions)=>Promise<LookupAddress[]>=lookup){
  const addresses=await resolve(host,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(entry=>!publicMailAddress(entry.address)))throw new Error('WEBMAIL_PRIVATE_HOST');
  return addresses.find(entry=>entry.family===4)?.address||addresses[0].address;
}
export function webmailError(error:unknown){
  const e=error as {authenticationFailed?:boolean;code?:string;message?:string};
  if(e.authenticationFailed||e.code==='AUTHENTICATIONFAILED')return 'Webmail từ chối đăng nhập. Kiểm tra username, mật khẩu và quyền IMAP.';
  if(e.message==='WEBMAIL_PRIVATE_HOST')return 'Máy chủ IMAP phải là hostname công khai của nhà cung cấp email.';
  if(e.code==='WEBMAIL_BACKLOG')return 'Đang đồng bộ tiếp hộp thư. Bấm Đồng bộ hoặc chờ lượt cron tiếp theo; tiến trình đã được lưu.';
  if(e.code==='WEBMAIL_BUSY')return 'Hộp thư đang được đồng bộ ở lượt khác. Vui lòng đợi rồi thử lại.';
  if(e.code==='ENOTFOUND'||e.code==='EAI_AGAIN')return 'Không tìm thấy máy chủ IMAP. Kiểm tra hostname.';
  if(/CERT|TLS|SSL|SELF_SIGNED/.test(e.code||''))return 'Chứng chỉ SSL/TLS của máy chủ IMAP không hợp lệ. Kiểm tra hostname hoặc liên hệ hosting.';
  if(e.code==='ETIMEDOUT'||e.code==='ETIMEOUT'||e.code==='WEBMAIL_TIMEOUT')return 'Kết nối IMAP hết thời gian chờ. Kiểm tra cổng 993 hoặc thử lại.';
  return 'Không kết nối hoặc đồng bộ được Webmail. Kiểm tra cấu hình IMAP và thử lại.';
}
export async function withWebmail<T>(input:Pick<WebmailInput,'host'|'port'|'username'|'password'>,budgetMs:number,work:(client:ImapFlow)=>Promise<T>){
  let client:ImapFlow|undefined;
  let active=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const task=(async()=>{
    const address=await publicMailHost(input.host);
    if(!active)throw Object.assign(new Error('WEBMAIL_TIMEOUT'),{code:'WEBMAIL_TIMEOUT'});
    client=new ImapFlow({host:address,port:input.port,secure:true,servername:input.host,tls:{servername:input.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:input.username,pass:input.password},logger:false,disableAutoIdle:true,connectionTimeout:budgetMs,greetingTimeout:budgetMs,socketTimeout:budgetMs});
    client.on('error',()=>{});
    await client.connect();
    return work(client);
  })();
  try{
    return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{client?.close();reject(Object.assign(new Error('WEBMAIL_TIMEOUT'),{code:'WEBMAIL_TIMEOUT'}));},budgetMs);})]);
  }finally{active=false;if(timer)clearTimeout(timer);client?.close();}
}

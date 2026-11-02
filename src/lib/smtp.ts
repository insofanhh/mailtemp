import nodemailer, {type SendMailOptions} from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import {Socket} from 'node:net';

export const SMTP_TIMEOUTS={connection:30_000,greeting:30_000,socket:60_000,total:90_000} as const;
export type SmtpStage='connecting'|'greeting'|'authentication'|'envelope'|'data';
export type DeliveryFailure={status:'failed'|'unknown';message:string};

export function classifySmtpFailure(error:unknown,stage:SmtpStage):DeliveryFailure {
  const detail=(error&&typeof error==='object'?error:{}) as {code?:unknown;responseCode?:unknown};
  const responseCode=Number(detail.responseCode);
  const code=typeof detail.code==='string'&&/^[A-Z][A-Z0-9_]{0,39}$/.test(detail.code)?detail.code:'SMTP_ERROR';
  if(responseCode>=400&&responseCode<600){
    const reason=responseCode===535?'Xác thực tài khoản gửi bị từ chối. Kiểm tra tài khoản, mật khẩu hoặc phương thức xác thực.':responseCode===550?'Máy chủ từ chối người gửi, người nhận hoặc nội dung thư. Kiểm tra chính sách SMTP.':'Máy chủ từ chối yêu cầu gửi. Kiểm tra cấu hình và chính sách nhà cung cấp.';
    return {status:'failed',message:`Gửi thất bại (SMTP ${responseCode}). ${reason} Không tự gửi lại.`};
  }
  // Nodemailer can report command=CONN even after DATA. Use observed transaction
  // progress, never that error field alone, to decide whether delivery is possible.
  if(stage!=='data'){
    const label={connecting:'kết nối / TLS',greeting:'chào SMTP / TLS',authentication:'xác thực tài khoản gửi',envelope:'khai báo người gửi / người nhận'}[stage];
    const hint=code==='ETIMEDOUT'?'Hết thời gian chờ. Kiểm tra kết nối mạng, máy chủ và thời gian chờ SMTP.':stage==='authentication'?'Kiểm tra tài khoản, mật khẩu và phương thức xác thực.':'Kiểm tra máy chủ, cổng, SSL/TLS và kết nối mạng.';
    return {status:'failed',message:`Chưa gửi thư: lỗi ở bước ${label} (${code}). ${hint} Nội dung thư chưa được truyền; không cần đối soát. Không tự gửi lại.`};
  }
  return {status:'unknown',message:`Chưa xác định kết quả gửi (${code}, sau khi bắt đầu DATA). Kiểm tra với nhà cung cấp theo Message-ID trước khi gửi lại.`};
}

export class SmtpDeliveryError extends Error {
  readonly failure:DeliveryFailure;
  constructor(error:unknown,stage:SmtpStage){
    const failure=classifySmtpFailure(error,stage);
    super(failure.message);this.name='SmtpDeliveryError';this.failure=failure;
  }
}

export function deliveryFailure(error:unknown):DeliveryFailure {
  return error instanceof SmtpDeliveryError?error.failure:{status:'unknown',message:'Chưa xác định kết quả gửi. Kiểm tra với nhà cung cấp theo Message-ID trước khi gửi lại.'};
}

export function mailReady(){return Boolean(process.env.MAIL_ENABLED==='true'&&process.env.SMTP_HOST&&process.env.SMTP_FROM_EMAIL);}

// Options are an in-process test seam; clients cannot choose transport settings.
export async function smtpTransport(options?:SMTPTransport.Options,observe?:(stage:SmtpStage)=>void,socket?:Socket){
  if(!options&&!mailReady())throw Object.assign(new Error('SMTP chưa cấu hình hoặc MAIL_ENABLED chưa bật.'),{code:'ECONFIG'});
  const config:SMTPTransport.Options=options??{host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',requireTLS:process.env.SMTP_SECURE!=='true',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined};
  let dataStarted=false;
  const observeCommand=(entry:object,message?:string)=>{
    if(dataStarted||(entry as {tnx?:string}).tnx!=='client'||typeof message!=='string')return;
    if(/^(DATA|BDAT)(?:\s|$)/i.test(message)){dataStarted=true;observe?.('data');}
    else if(/^(EHLO|HELO|LHLO|STARTTLS)(?:\s|$)/i.test(message))observe?.('greeting');
    else if(/^AUTH(?:\s|$)/i.test(message))observe?.('authentication');
    else if(/^(MAIL FROM|RCPT TO):/i.test(message))observe?.('envelope');
  };
  // Consume transaction events only to track progress. Never print or retain
  // protocol text, credentials, recipient details or message bodies.
  const logger={trace:()=>{},debug:observeCommand,info:()=>{},warn:()=>{},error:()=>{},fatal:()=>{}};
  return nodemailer.createTransport({...config,...(socket?{socket}:{}),connectionTimeout:SMTP_TIMEOUTS.connection,greetingTimeout:SMTP_TIMEOUTS.greeting,socketTimeout:SMTP_TIMEOUTS.socket,disableFileAccess:true,disableUrlAccess:true,debug:false,transactionLog:true,logger});
}

export async function sendSmtpMail(message:SendMailOptions,options?:SMTPTransport.Options,deadlineMs:number=SMTP_TIMEOUTS.total){
  let stage:SmtpStage='connecting',timer:ReturnType<typeof setTimeout>|undefined;
  const socket=new Socket();
  let transport:Awaited<ReturnType<typeof smtpTransport>>|undefined;
  try{
    transport=await smtpTransport(options,value=>{stage=value;},socket);
    const result=await Promise.race([transport.sendMail(message),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('SMTP deadline'),{code:'ETIMEDOUT'})),deadlineMs);})]);
    if(!result.accepted?.length)throw Object.assign(new Error('No accepted recipient'),{responseCode:550});
    return result;
  }catch(error){throw new SmtpDeliveryError(error,stage);}
  finally{if(timer)clearTimeout(timer);socket.destroy();transport?.close();}
}

// AUTH/connection check only: verify() never submits a message or recipient.
export async function verifySmtp(options?:SMTPTransport.Options,deadlineMs:number=SMTP_TIMEOUTS.total){
  let stage:SmtpStage='connecting',timer:ReturnType<typeof setTimeout>|undefined;
  const socket=new Socket();
  let transport:Awaited<ReturnType<typeof smtpTransport>>|undefined;
  try{
    transport=await smtpTransport(options,value=>{stage=value;},socket);
    await Promise.race([transport.verify(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('SMTP deadline'),{code:'ETIMEDOUT'})),deadlineMs);})]);
    return {ok:true as const,message:'Kết nối và xác thực SMTP thành công. Chưa gửi email.'};
  }catch(error){return {ok:false as const,message:classifySmtpFailure(error,stage).message};}
  finally{if(timer)clearTimeout(timer);socket.destroy();transport?.close();}
}

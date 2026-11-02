import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

function cipherKey(){
  const key=process.env.TOKEN_ENCRYPTION_KEY;
  if(!key||key.length<32)throw new Error('Thiếu TOKEN_ENCRYPTION_KEY.');
  return createHash('sha256').update(key).digest();
}
export function encrypt(text:string){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cipherKey(),iv);
  const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function decrypt(text:string){
  const data=Buffer.from(text,'base64');
  if(data.length<28)throw new Error('Dữ liệu mã hóa không hợp lệ.');
  const decipher=createDecipheriv('aes-256-gcm',cipherKey(),data.subarray(0,12));
  decipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
}

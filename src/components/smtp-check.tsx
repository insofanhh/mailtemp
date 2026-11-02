'use client';
import {useState} from 'react';

export function SmtpCheck({checkedAt,status,message}:{checkedAt?:string;status?:string;message?:string}){
  const [busy,setBusy]=useState(false),[result,setResult]=useState('');
  async function check(){
    setBusy(true);setResult('');
    try{
      const response=await fetch('/api/operations/smtp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const value=await response.json();setResult(value.message||value.error||'Không kiểm tra được SMTP.');
    }catch{setResult('Không nhận được kết quả kiểm tra SMTP. Hãy thử lại.');}
    finally{setBusy(false);}
  }
  return <div><div className="setting-status"><span>Kiểm tra kết nối gần nhất</span><strong>{status==='success'?'Thành công':status==='failed'?'Không thành công':'Chưa kiểm tra'}</strong></div>{checkedAt&&<small>Lúc {new Date(checkedAt).toLocaleString('vi-VN')}</small>}{message&&<p className="muted">{message}</p>}<button className="button secondary small-button" disabled={busy} onClick={()=>void check()}>{busy?'Đang kiểm tra…':'Kiểm tra kết nối SMTP'}</button><small className="settings-note">Chỉ kiểm tra kết nối và xác thực, không gửi email. Kết quả gửi từng thư được ghi riêng.</small>{result&&<p role="status">{result}</p>}</div>;
}

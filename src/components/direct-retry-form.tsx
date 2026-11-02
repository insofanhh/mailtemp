'use client';
import {useState} from 'react';

export function DirectRetryForm({email,busy,onSubmit,onClose}:{email:string;busy:boolean;onSubmit:(reason:string)=>Promise<void>;onClose:()=>void}){
  const [reason,setReason]=useState(''),[accepted,setAccepted]=useState(false);
  return <form className="direct-reconcile" aria-label="Cho phép gửi lại một lần" onSubmit={event=>{event.preventDefault();if(accepted&&!busy)void onSubmit(reason);}}>
    <h3>Cho phép gửi lại một lần</h3><p>{email}</p>
    <p>Lượt cũ vẫn chưa xác định đã gửi hay chưa. Mở khóa không xác nhận thư chưa được gửi và không tự gửi email. Người gửi cần kiểm tra danh sách và xác nhận lượt mới.</p>
    <label>Lý do mở khóa<textarea required minLength={20} maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy}/></label>
    <label className="checkbox-label"><input type="checkbox" required checked={accepted} onChange={event=>setAccepted(event.target.checked)} disabled={busy}/>Tôi chấp nhận người nhận có thể nhận trùng thư và cho phép tạo một lượt gửi thay thế.</label>
    <div className="direct-contact-tools"><button className="button primary" disabled={busy||!accepted||reason.trim().length<20}>Xác nhận mở khóa một lần</button><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Quay lại</button></div>
  </form>;
}

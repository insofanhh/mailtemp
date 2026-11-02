'use client';
import {useEffect,useRef,useState} from 'react';
import {Mail,CheckCircle2,X,LoaderCircle,RefreshCw} from 'lucide-react';

type Box={email:string;provider:string;lastSyncAt?:string;lastError?:string};
type Props={box?:Box;googleConfigured:boolean;microsoftConfigured:boolean;api:(path:string,body?:unknown,method?:string)=>Promise<unknown>;flash:(message:string)=>void};

export function MailboxConnection({box,googleConfigured,microsoftConfigured,api,flash}:Props){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function sync(){
    setBusy(true);setError('');
    try{const result=await api('mailbox/sync') as {processed:number};flash(`Đã đồng bộ: ${result.processed} phản hồi mới.`);}
    catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  return <section className="panel settings-card">
    <div className="section-icon"><Mail size={20}/></div><h2>Hộp thư của bạn</h2>
    <p>Kết nối Google, Microsoft hoặc Webmail để đồng bộ phản hồi của đối tác.</p>
    {box?<>
      <div className="connected-mailbox"><CheckCircle2 size={18}/><div><strong>{box.email}</strong><small>{box.provider==='imap'?'Webmail · IMAP SSL/TLS':box.provider} · Đồng bộ: {box.lastSyncAt?new Date(box.lastSyncAt+'Z').toLocaleString('vi-VN'):'Chưa đồng bộ'}</small>{box.lastError&&<p className="error-text">{box.lastError}</p>}</div></div>
      <div className="connection-buttons"><button className="button secondary" disabled={busy} onClick={()=>void sync()}><RefreshCw size={15}/>{busy?'Đang xử lý…':'Đồng bộ ngay'}</button><button className="text-button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api('mailbox/disconnect');flash('Đã ngắt kết nối hộp thư.');}catch(error){setError((error as Error).message);}finally{setBusy(false);}}}>Ngắt kết nối</button></div>
      {box.provider==='imap'&&<small className="settings-note">Webmail nhận phản hồi qua IMAP. Gửi thư dùng dịch vụ SMTP đã cấu hình; Reply-To mặc định là hộp thư này nếu máy chủ chưa đặt SMTP_REPLY_TO.</small>}
    </>:<>
      <div className="connection-buttons">
        <a aria-disabled={!googleConfigured} className={`button secondary ${!googleConfigured?'disabled':''}`} href={googleConfigured?'/api/oauth/google/start':undefined}><span className="google-g">G</span>Kết nối Google</a>
        <a aria-disabled={!microsoftConfigured} className={`button secondary ${!microsoftConfigured?'disabled':''}`} href={microsoftConfigured?'/api/oauth/microsoft/start':undefined}><span className="microsoft-logo"><i/><i/><i/><i/></span>Kết nối Microsoft</a>
        <button className="button secondary" onClick={()=>setOpen(true)}><Mail size={16}/>Kết nối Webmail</button>
      </div>
      <small className="settings-note">Webmail dùng tài khoản IMAP, không cần OAuth. Google/Microsoft cần quản trị viên cấu hình OAuth client.</small>
    </>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {open&&<WebmailForm api={api} onClose={()=>setOpen(false)} onConnected={()=>{setOpen(false);flash('Đã kiểm tra và kết nối Webmail. Bấm Đồng bộ ngay để nhận phản hồi.');}}/>}
  </section>;
}

function WebmailForm({api,onClose,onConnected}:{api:Props['api'];onClose:()=>void;onConnected:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [input,setInput]=useState({email:'',host:'',username:'',password:''});
  useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
  return <dialog ref={dialog} className="dialog" onCancel={event=>{if(busy)event.preventDefault();else onClose();}}>
    <div className="dialog-header"><div><h2>Kết nối Webmail</h2><p>Nhập thông số Secure SSL/TLS từ Configure Mail Client của hosting.</p></div><button className="icon-button" disabled={busy} aria-label="Đóng" onClick={onClose}><X size={20}/></button></div>
    <form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');try{await api('mailbox/webmail',{...input,port:993});setInput(value=>({...value,password:''}));onConnected();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}}>
      <fieldset disabled={busy} className="webmail-fields"><div className="form-grid">
        <label className="full">Địa chỉ email<input type="email" required maxLength={254} autoComplete="off" placeholder="sale@tenmien.com" value={input.email} onChange={e=>{const email=e.target.value;setInput(value=>({...value,email,username:!value.username||value.username===value.email?email:value.username}));}}/></label>
        <label className="full">Máy chủ nhận IMAP<input required maxLength={253} placeholder="mail.tenmien.com" value={input.host} onChange={e=>setInput(value=>({...value,host:e.target.value}))}/></label>
        <label>Cổng IMAP<input readOnly value="993"/></label><label>Bảo mật<input readOnly value="SSL/TLS"/></label>
        <label className="full">Username<input required maxLength={254} autoComplete="off" value={input.username} onChange={e=>setInput(value=>({...value,username:e.target.value}))}/></label>
        <label className="full">Mật khẩu hộp thư<input type="password" required maxLength={1024} autoComplete="new-password" value={input.password} onChange={e=>setInput(value=>({...value,password:e.target.value}))}/></label>
        <small className="full muted">Mật khẩu được mã hóa trên máy chủ. Hệ thống chỉ đọc INBOX, không đánh dấu thư đã đọc. Lần đầu lấy phản hồi từ liên hệ của bạn trong 7 ngày gần nhất. Gửi thư vẫn dùng SMTP hiện có.</small>
      </div></fieldset>
      {error&&<div className="form-error" role="alert">{error}</div>}
      <footer className="dialog-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Hủy</button><button className="button primary" disabled={busy}>{busy&&<LoaderCircle size={16} className="spin"/>}{busy?'Đang kiểm tra kết nối…':'Kiểm tra & kết nối'}</button></footer>
    </form>
  </dialog>;
}

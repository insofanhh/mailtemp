'use client';
import {useEffect,useRef,useState} from 'react';
import {LoaderCircle,Trash2,X,CheckCircle2} from 'lucide-react';
import type {CrudRow} from './crud-manager';

export function PageSelectionCheckbox({checked,mixed,disabled,onChange}:{checked:boolean;mixed:boolean;disabled?:boolean;onChange:()=>void}){
  const ref=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(ref.current)ref.current.indeterminate=mixed;},[mixed]);
  return <input ref={ref} type="checkbox" aria-label="Chọn tất cả liên hệ trên trang này" checked={checked} disabled={disabled} onChange={onChange}/>;
}
type Result={deleted:number;missing:number;skipped:{id:string;name:string;email:string;reason:string}[]};
export function BulkDeleteContacts({contacts,page,onClose,onDone}:{contacts:CrudRow[];page:number;onClose:()=>void;onDone:()=>Promise<void>}){
  const dialog=useRef<HTMLDialogElement>(null),inflight=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  const close=()=>{if(!inflight.current)onClose();};
  async function remove(){
    if(inflight.current||result)return;inflight.current=true;setBusy(true);setError('');
    try{
      const response=await fetch('/api/contacts/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:contacts.map(contact=>contact.id)}),signal:AbortSignal.timeout(45000)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'Không xóa được liên hệ.');
      setResult(data);try{await onDone();}catch{setError('Đã xử lý yêu cầu. Hãy tải lại trang để cập nhật danh sách.');}
    }catch(error){setError(error instanceof TypeError||error instanceof DOMException?'Kết nối bị gián đoạn. Hãy đóng cửa sổ và tải lại danh sách để kiểm tra kết quả trước khi thử lại.':(error as Error).message);}
    finally{inflight.current=false;setBusy(false);}
  }
  return <dialog ref={dialog} className="dialog bulk-delete-dialog" onCancel={event=>{event.preventDefault();close();}}><header className="dialog-header"><div><h2>{result?'Kết quả xóa hàng loạt':'Xóa liên hệ đã chọn'}</h2><p>{contacts.length} liên hệ được chọn trên trang {page}.</p></div><button className="icon-button" aria-label="Đóng xóa hàng loạt" disabled={busy} onClick={close}><X size={20}/></button></header><div className="detail-body">
    {result?<><div className="bulk-delete-summary" role="status"><CheckCircle2 size={20}/><div><strong>Đã xóa {result.deleted} liên hệ</strong><p>Bỏ qua {result.skipped.length} liên hệ có dữ liệu liên quan{result.missing?` · ${result.missing} liên hệ không còn tồn tại`:''}.</p></div></div>{result.skipped.length>0&&<><h3>Các liên hệ chưa xóa</h3><ul className="bulk-contact-list">{result.skipped.map(contact=><li key={contact.id}><strong>{contact.name||contact.email}</strong><span>{contact.email}</span><p>{contact.reason}</p></li>)}</ul></>}</>:<><p>Chỉ xóa những liên hệ bạn đã chọn ở trang này. Thao tác không thể hoàn tác.</p><ul className="bulk-contact-list">{contacts.map(contact=><li key={String(contact.id)}><strong>{contact.name||contact.email}</strong><span>{contact.email}</span></li>)}</ul><p>Liên hệ đang có trong chiến dịch hoặc còn thư phản hồi sẽ được bỏ qua và liệt kê trong kết quả. Hồ sơ đại lý và danh sách chặn được giữ nguyên.</p></>}
    {error&&<div className="form-error" role="alert">{error}</div>}
  </div><footer className="dialog-footer"><button className="button secondary" disabled={busy} onClick={close}>{result?'Đóng':'Hủy'}</button>{!result&&<button className="button danger" disabled={busy} onClick={()=>void remove()}>{busy?<LoaderCircle size={15} className="spin"/>:<Trash2 size={15}/>} {busy?'Đang xóa…':`Xác nhận xóa ${contacts.length} liên hệ`}</button>}</footer></dialog>;
}

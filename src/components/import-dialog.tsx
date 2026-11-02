'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,Check,Download,Eye,LoaderCircle,Upload,X} from 'lucide-react';
import {IMPORT_CHUNK_SIZE,IMPORT_MAX_BYTES,IMPORT_MAX_ROWS,importFields,mapImportRows,sheetImportData,suggestImportMapping,type ImportField,type ImportMapping,type ImportPreview,type ImportProgress,type ImportSheet} from '@/lib/import-data';

async function importRequest(body:unknown,retry=false){
  for(let attempt=0;attempt<(retry?2:1);attempt++){
    try{
      const response=await fetch('/api/import',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Không nhập được dữ liệu.');return result;
    }catch(error){
      const network=error instanceof TypeError||error instanceof DOMException;
      if(!network)throw error;
      if(!retry||attempt===1)throw new Error(retry?'Kết nối bị gián đoạn. Phần đã nhập được giữ lại; bấm Tiếp tục nhập để xử lý phần còn lại.':'Kết nối bị gián đoạn. Hãy thử kiểm tra dữ liệu lại.');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
}
const count=(value:number)=>value.toLocaleString('vi-VN');

export function ImportDialog({onClose,onDone}:{onClose:()=>void;onDone:()=>Promise<void>}){
  const dialog=useRef<HTMLDialogElement>(null),inflight=useRef(false),requestId=useRef<string|null>(null);
  const [step,setStep]=useState<'file'|'mapping'|'preview'|'done'>('file'),[filename,setFilename]=useState(''),[sheets,setSheets]=useState<ImportSheet[]>([]),[sheetIndex,setSheetIndex]=useState(0),[headerRow,setHeaderRow]=useState(1),[mapping,setMapping]=useState<ImportMapping>({}),[source,setSource]=useState(''),[preview,setPreview]=useState<ImportPreview|null>(null),[job,setJob]=useState<ImportProgress|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const element=dialog.current;element?.showModal();return()=>element?.close();},[]);
  const sheet=sheets[sheetIndex],data=useMemo(()=>sheet?sheetImportData(sheet,headerRow):{headers:[],entries:[]},[sheet,headerRow]);
  const selected=importFields.filter(field=>Object.values(mapping).includes(field.key));
  const mapped=Object.values(mapping).filter(Boolean),duplicates=mapped.length!==new Set(mapped).size;
  const ready=Boolean(data.entries.length&&data.entries.length<=IMPORT_MAX_ROWS&&mapped.includes('email')&&!duplicates);

  function chooseLayout(index:number,row:number){setSheetIndex(index);setHeaderRow(row);setMapping(suggestImportMapping(sheetImportData(sheets[index],row).headers));setError('');}
  async function upload(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();if(inflight.current)return;
    const form=new FormData(event.currentTarget),file=form.get('file');
    if(!(file instanceof File)||!file.size||file.size>IMPORT_MAX_BYTES){setError('Chọn tệp CSV hoặc XLSX tối đa 20 MB.');return;}
    inflight.current=true;setBusy(true);setError('');form.set('inspect','true');
    try{
      const response=await fetch('/api/import',{method:'POST',credentials:'same-origin',body:form,signal:AbortSignal.timeout(90000)}),result=await response.json();
      if(!response.ok)throw new Error(result.error||'Không đọc được tệp.');
      setFilename(result.filename);setSheets(result.sheets);setSheetIndex(0);setHeaderRow(1);setMapping(suggestImportMapping(sheetImportData(result.sheets[0],1).headers));setStep('mapping');
    }catch(error){setError(error instanceof TypeError?'Không kết nối được máy chủ. Kiểm tra kết nối rồi chọn lại tệp.':(error as Error).message);}
    finally{inflight.current=false;setBusy(false);}
  }
  async function check(){
    if(!sheet||!ready||inflight.current)return;inflight.current=true;setBusy(true);setError('');
    try{const result=await importRequest({action:'preview',filename,records:mapImportRows(sheet,headerRow,mapping,source)});setPreview(result);setStep('preview');}
    catch(error){setError((error as Error).message);}finally{inflight.current=false;setBusy(false);}
  }
  async function commit(){
    if(!preview?.records.length||inflight.current)return;inflight.current=true;setBusy(true);setError('');
    try{
      requestId.current??=crypto.randomUUID();
      let current:ImportProgress=await importRequest({action:'start',id:requestId.current,filename,total:preview.records.length},true);setJob(current);
      while(current.status!=='completed'){
        current=await importRequest({action:'chunk',id:current.id,index:current.nextChunk,records:preview.records.slice(current.processed,current.processed+IMPORT_CHUNK_SIZE)},true);setJob(current);
      }
      setStep('done');try{await onDone();}catch{setError('Đã nhập xong. Tải lại trang để cập nhật danh sách.');}
    }catch(error){setError((error as Error).message);}finally{inflight.current=false;setBusy(false);}
  }
  const close=()=>{if(!inflight.current)onClose();};
  return <dialog ref={dialog} className="dialog wide import-dialog" onCancel={event=>{event.preventDefault();close();}}>
    <header className="dialog-header"><div><h2>Nhập dữ liệu liên hệ</h2><p>CSV hoặc XLSX · Tối đa 20.000 dòng dữ liệu / 20 MB mỗi lần.</p></div><button className="icon-button" aria-label="Đóng nhập dữ liệu" disabled={busy} onClick={close}><X size={20}/></button></header>
    <div className="import-steps" aria-label="Các bước nhập dữ liệu">{['Chọn tệp','Ghép cột dữ liệu','Kiểm tra & nhập'].map((label,index)=><span key={label} className={(step==='file'?0:step==='mapping'?1:2)===index?'active':''}><b>{index+1}</b>{label}</span>)}</div>
    <div className="detail-body">
      {step==='file'&&<form id="import-form" onSubmit={upload}><a className="download-template" href="/import-template.csv" download><Download size={16}/>Tải tệp CSV mẫu</a><label className="upload-zone"><Upload size={26}/><strong>Chọn tệp dữ liệu đại lý</strong><span>Có thể dùng tên cột bất kỳ. Ở bước tiếp theo, chọn cột cần nhập và trường tương ứng trong hệ thống.</span><input aria-label="Tệp nhập liên hệ" type="file" name="file" accept=".csv,.xlsx" required disabled={busy}/></label><p className="muted">Chưa ghi dữ liệu khi đọc tệp hoặc xem trước.</p></form>}
      {step==='mapping'&&<>
        <div className="import-file-summary"><strong>{filename}</strong><span>{count(data.entries.length)} dòng · {data.headers.length} cột</span></div>
        <div className="import-layout"><label>Sheet dữ liệu<select value={sheetIndex} disabled={busy} onChange={event=>chooseLayout(Number(event.target.value),1)}>{sheets.map((sheet,index)=><option value={index} key={index}>{sheet.name}</option>)}</select></label><label>Dòng tiêu đề<select value={headerRow} disabled={busy} onChange={event=>chooseLayout(sheetIndex,Number(event.target.value))}>{Array.from({length:Math.min(50,sheet?.rows.length||1)},(_,i)=><option key={i} value={i+1}>Dòng {i+1} · {sheet?.rows[i]?.slice(0,3).join(' / ').slice(0,85)||'(trống)'}</option>)}</select></label></div>
        <div className="import-mapping-heading"><div><h3>Ghép cột trong tệp với trường của hệ thống</h3><p>Cột không dùng để “Bỏ qua”. Mỗi trường hệ thống chỉ ghép với một cột.</p></div><button className="text-button" disabled={busy} onClick={()=>setMapping({})}>Bỏ chọn tất cả</button></div>
        <div className="table-scroll import-mapping-table"><table><thead><tr><th>CỘT TRONG TỆP</th><th>DỮ LIỆU VÍ DỤ</th><th>NHẬP VÀO TRƯỜNG</th></tr></thead><tbody>{data.headers.map((header,index)=><tr key={index} className={mapping[String(index)]?'mapped':''}><td><small>Cột {index+1}</small><strong>{header}</strong></td><td><span>{data.entries.slice(0,3).map(entry=>entry.values[index]||'—').join(' · ').slice(0,180)}</span></td><td><select aria-label={`Trường hệ thống cho cột ${index+1}: ${header}`} value={mapping[String(index)]||''} disabled={busy} onChange={event=>setMapping(previous=>({...previous,[String(index)]:event.target.value as ImportField|''}))}><option value="">Bỏ qua cột này</option>{importFields.map(field=><option key={field.key} value={field.key} disabled={Object.entries(mapping).some(([key,value])=>key!==String(index)&&value===field.key)}>{field.label}{'required'in field&&field.required?' *':''}</option>)}</select></td></tr>)}</tbody></table></div>
        <p className="import-required">Bắt buộc: <strong>Email liên hệ</strong>. Các thông tin khác có thể để trống và bổ sung sau.</p>
        <label>Nguồn chung (tùy chọn, dùng khi cột nguồn trống)<input value={source} onChange={event=>setSource(event.target.value)} maxLength={1000} placeholder="URL website hoặc tên nguồn công ty cung cấp" disabled={busy}/></label>
        <p className="muted import-note">Thông tin công ty áp dụng khi tạo đại lý mới. Dữ liệu của đại lý đang có không bị ghi đè. Nếu chưa có tên công ty, mỗi liên hệ có hồ sơ đại lý trống riêng để bổ sung sau.</p>
        {data.entries.length>IMPORT_MAX_ROWS&&<p className="error-text">Sheet đang chọn có hơn 20.000 dòng dữ liệu. Hãy chọn lại dòng tiêu đề hoặc chia tệp nhỏ hơn.</p>}
        {!mapped.includes('email')&&<p className="error-text">Hãy ghép cột email trước khi xem trước.</p>}
      </>}
      {(step==='preview'||step==='done')&&preview&&<>
        <div className="import-file-summary"><strong>{filename}</strong><span>{selected.length} trường đã chọn</span></div>
        <div className="import-stats import-stats-expanded">{[[preview.total,'Tổng dòng'],[preview.records.length,'Có thể nhập'],[preview.duplicates,'Email đã có'],[preview.errorTotal,'Dòng lỗi'],[preview.conflicts,'Đại lý của sale khác']].map(([value,label])=><div key={String(label)}><strong>{count(Number(value))}</strong><span>{label}</span></div>)}</div>
        {job&&<section className={`import-progress ${job.status==='completed'?'complete':''}`} aria-live="polite"><strong>{job.status==='completed'?'Đã nhập hoàn tất':busy?'Đang nhập dữ liệu…':'Đang tạm dừng'}</strong><progress aria-label="Tiến độ nhập liên hệ" max={job.total} value={job.processed}/><p>Đã xử lý {count(job.processed)}/{count(job.total)} · Thêm mới {count(job.imported)} · Bỏ qua {count(job.skipped)}</p>{job.status!=='completed'&&<small>Giữ cửa sổ này đến khi hoàn tất. Nếu có lỗi kết nối, bấm Tiếp tục nhập.</small>}</section>}
        <div className="table-scroll import-preview-table"><table><thead><tr>{selected.map(field=><th key={field.key}>{field.label.toUpperCase()}</th>)}{!selected.some(field=>field.key==='source')&&<th>NGUỒN</th>}</tr></thead><tbody>{preview.records.slice(0,10).map((record,i)=><tr key={i}>{selected.map(field=><td key={field.key}>{record[field.key]||'—'}</td>)}{!selected.some(field=>field.key==='source')&&<td>{record.source||'—'}</td>}</tr>)}</tbody></table></div>
        <p className="muted">Đang xem trước {Math.min(10,preview.records.length)}/{count(preview.records.length)} dòng hợp lệ. Liên hệ mới chưa được duyệt quyền gửi.</p>
        {preview.errorTotal>0&&<div className="import-errors">{preview.errors.slice(0,30).map(item=><p key={item.row}>Dòng {item.row}: {item.error}</p>)}{preview.errorTotal>30&&<p>Còn {count(preview.errorTotal-30)} dòng lỗi khác. Chỉ các dòng hợp lệ được nhập.</p>}</div>}
        {preview.conflicts>0&&<p className="muted">Bỏ qua {count(preview.conflicts)} dòng thuộc đại lý của sale khác.</p>}
      </>}
      {error&&<div className="form-error" role="alert">{error}</div>}
    </div>
    <footer className="dialog-footer"><button className="button secondary" disabled={busy} onClick={()=>{if(step==='preview'&&!job){setStep('mapping');setError('');}else if(step==='mapping'){setStep('file');setError('');}else close();}}>{step==='done'||job?'Đóng':step==='mapping'?'Chọn tệp khác':step==='preview'&&!job?'Sửa ghép cột':'Hủy'}</button>
      {step==='file'&&<button type="submit" form="import-form" className="button primary" disabled={busy}>{busy?<LoaderCircle size={15} className="spin"/>:<ArrowRight size={15}/>}Đọc tệp & chọn cột</button>}
      {step==='mapping'&&<button className="button primary" disabled={busy||!ready} onClick={()=>void check()}>{busy?<LoaderCircle size={15} className="spin"/>:<Eye size={15}/>}Kiểm tra & xem trước</button>}
      {step==='preview'&&<button className="button primary" disabled={busy||!preview?.records.length} onClick={()=>void commit()}>{busy?<LoaderCircle size={15} className="spin"/>:<Check size={15}/>} {busy?'Đang nhập…':job?'Tiếp tục nhập':`Nhập ${count(preview?.records.length||0)} liên hệ`}</button>}
      {step==='done'&&<button className="button primary" onClick={close}><Check size={15}/>Xem dữ liệu đã nhập</button>}
    </footer>
  </dialog>;
}

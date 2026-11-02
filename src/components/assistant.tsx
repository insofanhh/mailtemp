'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Sparkles,X,Plus,ArrowUp,FileText,Copy,Check,LoaderCircle,ChevronRight,MessageCircle,ExternalLink,AlertCircle,Database} from 'lucide-react';
import type {AssistantDraft,AssistantMessage,AssistantSource,SavedDraft,assistantViews,entityTypes} from '@/lib/assistant-schema';
import {saveAssistantDraft} from '@/lib/assistant-client';

type View=typeof assistantViews[number];
type Context={type:typeof entityTypes[number];id:string;label:string};
type State={threads:{id:string;title:string;updatedAt:string}[];messages:AssistantMessage[];threadId:string|null;config:{enabled:boolean;model:string;dailyLimit:number};usage:{requests:number;inputTokens:number;outputTokens:number}};
type Props={open:boolean;onOpenChange:(open:boolean)=>void;view:View;context?:Context;choices:Context[];onSaved:(kind:string,id:string)=>Promise<void>;onSource:(source:AssistantSource)=>void};
const labels:Record<string,string>={template:'Mẫu email',reply:'Gợi ý trả lời',task:'Công việc',rfq:'Yêu cầu báo giá',quote:'Phiên bản báo giá',campaign:'Chiến dịch nháp'};
const viewLabels:Record<View,string>={dashboard:'Tổng quan',accounts:'Đại lý',contacts:'Liên hệ',products:'Tour & bảng giá',templates:'Mẫu thư',campaigns:'Chiến dịch','direct-mail':'Gửi mail trực tiếp',inbox:'Phản hồi',rfqs:'RFQ & báo giá',tasks:'Công việc',settings:'Cài đặt'};
async function responseData(response:Response){const value=await response.json();if(!response.ok)throw new Error(value.error||'Không kết nối được trợ lý.');return value;}

export function Assistant({open,onOpenChange,view,context,choices,onSaved,onSource}:Props){
  const [state,setState]=useState<State|null>(null),[messages,setMessages]=useState<AssistantMessage[]>([]),[threadId,setThreadId]=useState<string|null>(null),[text,setText]=useState(''),[mode,setMode]=useState<'chat'|'template'>('chat'),[tone,setTone]=useState('Chuyên nghiệp, tự nhiên'),[language,setLanguage]=useState('Theo ngôn ngữ thư mẫu'),[useWorkspace,setUseWorkspace]=useState(true),[contextKey,setContextKey]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const end=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),launcher=useRef<HTMLButtonElement>(null),inflight=useRef(false),loaded=useRef(false),historySequence=useRef(0),mounted=useRef(true);
  const selected=contextKey==='none'?undefined:contextKey?choices.find(c=>c.type+':'+c.id===contextKey):context;
  const load=useCallback(async(id?:string)=>{
    const sequence=++historySequence.current;setLoading(true);setError('');
    try{const value=await responseData(await fetch('/api/assistant'+(id?'?threadId='+id:''),{cache:'no-store'})) as State;if(!mounted.current||sequence!==historySequence.current)return;setState(value);setMessages(value.messages);setThreadId(value.threadId);loaded.current=true;}
    catch(error){if(mounted.current&&sequence===historySequence.current)setError((error as Error).message);}
    finally{if(mounted.current&&sequence===historySequence.current)setLoading(false);}
  },[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(open&&!loaded.current)void load();if(open)composer.current?.focus({preventScroll:true});},[open,load]);
  useEffect(()=>{const conversation=end.current?.parentElement;if(open&&conversation)conversation.scrollTo({top:conversation.scrollHeight,behavior:'smooth'});},[messages,busy,open]);
  function close(){onOpenChange(false);launcher.current?.focus({preventScroll:true});}
  function starter(index:number){
    if(index===0)setMode('template');
    else{setMode('chat');setText(index===1?'Dựa trên dữ liệu hiện tại, hôm nay tôi nên ưu tiên những việc nào? Hãy nêu lý do và bước tiếp theo.':'Kiểm tra các chiến dịch của tôi: những điểm nào cần xử lý trước khi gửi?');}
    composer.current?.focus({preventScroll:true});
  }
  async function send(event?:React.FormEvent){
    event?.preventDefault();if(inflight.current||loading||!text.trim())return;inflight.current=true;setBusy(true);setError('');setNotice('');
    const input=text.trim(),message=mode==='template'?`Tạo mẫu email để lưu vào thư viện từ thư mẫu sau. Văn phong: ${tone}. Ngôn ngữ: ${language}. Dùng biến cá nhân hóa được hỗ trợ và không tự bịa giá/điều kiện.\n\nTHƯ MẪU:\n${input}`:input;
    const optimistic:AssistantMessage={id:'pending-'+crypto.randomUUID(),role:'user',content:message,createdAt:new Date().toISOString()};setMessages(previous=>[...previous,optimistic]);setText('');
    try{
      const value=await responseData(await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),...(threadId?{threadId}:{}),message,useWorkspace,view,...(selected&&useWorkspace?{context:{type:selected.type,id:selected.id}}:{})})})) as State;
      if(!mounted.current)return;setState(value);setThreadId(value.threadId);setMessages(value.messages);
    }catch(error){if(mounted.current){setError((error as Error).message);setMessages(previous=>previous.filter(m=>m.id!==optimistic.id));setText(input);}}
    finally{inflight.current=false;if(mounted.current)setBusy(false);}
  }
  async function saved(kind:string,id:string){setNotice('Đã lưu '+labels[kind]?.toLowerCase()+'.');try{await onSaved(kind,id);}catch{setNotice('Đã lưu thành công. Tải lại trang để xem bản ghi mới.');}}
  return <div className="ai-assistant">
    <button ref={launcher} className={`ai-launcher ${open?'is-open':''}`} aria-label={open?'Đóng trợ lý AI':'Mở trợ lý AI'} aria-expanded={open} aria-controls="ai-panel" onClick={()=>open?close():onOpenChange(true)}><Sparkles size={21}/><span>Trợ lý AI</span><i/></button>
    {open&&<section id="ai-panel" className="ai-panel" role="dialog" aria-modal="false" aria-labelledby="ai-heading" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}>
      <header className="ai-header"><span className="ai-logo"><Sparkles size={21}/></span><div><h2 id="ai-heading">Trợ lý Mailtemp <span>AI</span></h2><p>Đồng hành cùng công việc của bạn</p></div><button className="icon-button" aria-label="Cuộc trò chuyện mới" disabled={busy||loading} onClick={()=>{historySequence.current++;setThreadId(null);setMessages([]);setError('');setNotice('');setText('');composer.current?.focus({preventScroll:true});}}><Plus size={18}/></button><button className="icon-button" aria-label="Đóng trợ lý" onClick={close}><X size={19}/></button></header>
      <div className="ai-toolbar"><div className="ai-modes" role="group" aria-label="Chế độ trợ lý"><button aria-pressed={mode==='chat'} className={mode==='chat'?'active':''} onClick={()=>setMode('chat')}><MessageCircle size={14}/>Trò chuyện</button></div><select aria-label="Lịch sử trò chuyện" value={threadId||''} disabled={busy||loading} onChange={event=>{if(event.target.value)void load(event.target.value);}}><option value="">Cuộc trò chuyện mới</option>{state?.threads.map(thread=><option key={thread.id} value={thread.id}>{thread.title.slice(0,65)}</option>)}</select></div>
      <div className="ai-conversation" role="log" aria-label="Nội dung trò chuyện" aria-busy={busy||loading}>
        {loading&&<div className="ai-loading"><LoaderCircle size={18} className="spin"/>Đang tải cuộc trò chuyện…</div>}
        {!loading&&!messages.length&&<div className="ai-welcome"><span className="ai-welcome-icon"><Sparkles size={28}/></span><h3>Bắt đầu từ điều bạn cần làm.</h3><p>Dán một email mẫu, tìm việc cần ưu tiên hoặc nhờ mình chuẩn bị bước tiếp theo.</p><div className="ai-starters">{[
          {icon:FileText,title:'Tạo mẫu từ email có sẵn',hint:'Cá nhân hóa, chỉnh văn phong và lưu thư viện'},
          {icon:Check,title:'Hôm nay nên ưu tiên việc gì?',hint:'Tổng hợp công việc và cơ hội cần theo sát'},
          {icon:Database,title:'Kiểm tra chiến dịch trước khi gửi',hint:'Nhận diện điểm còn thiếu và hướng xử lý'},
        ].map((item,index)=><button key={item.title} onClick={()=>starter(index)}><item.icon size={17}/><span><strong>{item.title}</strong><small>{item.hint}</small></span><ChevronRight size={15}/></button>)}</div></div>}
        {messages.map(message=><article key={message.id} className={`ai-message ${message.role}`}><div className="ai-message-label">{message.role==='assistant'?<><Sparkles size={12}/>Mailtemp AI</>:'Bạn'}</div><div className="ai-message-text">{message.content}</div>{message.drafts?.map(draft=><DraftCard key={draft.id} draft={draft} onSaved={saved}/>)}{Boolean(message.sources?.length)&&<details className="ai-sources"><summary>Dữ liệu đã tham khảo · {message.sources!.length} bản ghi</summary>{message.sources!.map(source=><button key={source.type+source.id} onClick={()=>onSource(source)}><ExternalLink size={11}/>{source.label}</button>)}</details>}</article>)}
        {busy&&<div className="ai-thinking" role="status"><span><i/><i/><i/></span>Đang đọc yêu cầu và chuẩn bị phản hồi…</div>}
        {!busy&&messages.at(-1)?.suggestions?.length&&<div className="ai-suggestions">{messages.at(-1)!.suggestions!.map(suggestion=><button key={suggestion} onClick={()=>{setMode('chat');setText(suggestion);composer.current?.focus({preventScroll:true});}}>{suggestion}<ChevronRight size={12}/></button>)}</div>}
        <div ref={end}/>
      </div>
      {notice&&<div className="ai-notice" role="status"><Check size={14}/>{notice}</div>}
      {error&&<div className="ai-error" role="alert"><AlertCircle size={15}/><span>{error}</span>{!state&&!loading&&<button className="text-button" onClick={()=>void load()}>Thử lại</button>}</div>}
      <form className="ai-composer" onSubmit={send}>
        <div className="ai-context-row"><label className="ai-context-toggle"><input type="checkbox" checked={useWorkspace} disabled={busy} onChange={event=>setUseWorkspace(event.target.checked)}/><Database size={12}/>Dùng dữ liệu hệ thống</label><span>{viewLabels[view]}</span></div>
        {useWorkspace&&<select className="ai-context-select" aria-label="Hồ sơ hỗ trợ AI" value={contextKey} disabled={busy} onChange={event=>setContextKey(event.target.value)}><option value="">{context?'Đang xem: '+context.label:'Tra cứu theo yêu cầu của tôi'}</option><option value="none">Không gắn hồ sơ cụ thể</option>{choices.map(choice=><option key={choice.type+choice.id} value={choice.type+':'+choice.id}>{choice.label}</option>)}</select>}
        {mode==='template'&&<div className="ai-writing-options"><select aria-label="Văn phong email" value={tone} onChange={event=>setTone(event.target.value)}>{['Chuyên nghiệp, tự nhiên','Thân thiện, gần gũi','Ngắn gọn, đi thẳng vào nội dung'].map(value=><option key={value}>{value}</option>)}</select><select aria-label="Ngôn ngữ email" value={language} onChange={event=>setLanguage(event.target.value)}>{['Theo ngôn ngữ thư mẫu','Tiếng Việt','Tiếng Anh'].map(value=><option key={value}>{value}</option>)}</select></div>}
        <div className="ai-input-wrap"><textarea ref={composer} aria-label={mode==='template'?'Thư mẫu cho trợ lý':'Tin nhắn cho trợ lý'} placeholder={mode==='template'?'Dán đoạn email mẫu ở đây. Có thể thêm yêu cầu chỉnh sửa ở cuối…':'Bạn muốn mình hỗ trợ việc gì?'} value={text} onChange={event=>setText(event.target.value)} rows={mode==='template'?5:3} maxLength={mode==='template'?15000:16000} disabled={busy} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/><button type="submit" className="ai-send" aria-label={mode==='template'?'Tạo bản nháp mẫu email':'Gửi yêu cầu cho trợ lý'} disabled={busy||loading||!text.trim()||state?.config.enabled===false}>{busy?<LoaderCircle size={18} className="spin"/>:<ArrowUp size={19}/>}</button></div>
        <div className="ai-composer-foot"><span>{state?.config.enabled===false?'Chưa có cấu hình DeepSeek':`${Number(state?.usage.requests)||0}/${state?.config.dailyLimit||60} lượt trong 24h`}</span><span>Shift + Enter để xuống dòng</span></div><p className="ai-data-note">Nội dung chat và dữ liệu cần thiết được gửi tới DeepSeek. Kiểm tra bản nháp trước khi lưu.</p>
      </form>
    </section>}
  </div>;
}

function localDateTime(value:string){if(!value)return '';const date=new Date(value);if(Number.isNaN(date.getTime()))return '';return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replace(' ','T');}
function DraftCard({draft,onSaved}:{draft:SavedDraft;onSaved:(kind:string,id:string)=>Promise<void>}){
  const [editing,setEditing]=useState(false),[data,setData]=useState<Record<string,unknown>>(draft.data),[applied,setApplied]=useState(draft.status==='applied'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  const get=(key:string)=>String(data[key]??''),set=(key:string,value:unknown)=>setData(previous=>({...previous,[key]:value}));
  const fields:Record<string,{key:string;label:string;type?:string}[]>={
    template:[{key:'name',label:'Tên mẫu thư'},{key:'category',label:'Nhóm nội dung'},{key:'subject',label:'Tiêu đề'},{key:'body',label:'Nội dung',type:'textarea'}],
    reply:[{key:'subject',label:'Tiêu đề'},{key:'body',label:'Nội dung',type:'textarea'}],
    task:[{key:'title',label:'Công việc'},{key:'dueAt',label:'Hạn hoàn thành (giờ Việt Nam)',type:'datetime-local'},{key:'priority',label:'Ưu tiên'}],
    rfq:[{key:'title',label:'Tên yêu cầu'},{key:'destination',label:'Tuyến / điểm đến'},{key:'departureDate',label:'Ngày đi',type:'date'},{key:'pax',label:'Số khách',type:'number'},{key:'budget',label:'Ngân sách',type:'number'},{key:'deadline',label:'Hạn trả báo giá',type:'date'},{key:'notes',label:'Yêu cầu',type:'textarea'}],
    quote:[{key:'amount',label:'Giá trị',type:'number'},{key:'currency',label:'Tiền tệ'},{key:'validUntil',label:'Hiệu lực đến',type:'date'},{key:'conditions',label:'Điều kiện',type:'textarea'}],
    campaign:[{key:'name',label:'Tên chiến dịch'},{key:'followupBody',label:'Nội dung follow-up (tùy chọn)',type:'textarea'},{key:'followupDays',label:'Số ngày đến follow-up',type:'number'}],
  };
  async function copy(){try{const value=draft.kind==='template'||draft.kind==='reply'?get('subject')+'\n\n'+get('body'):JSON.stringify(data,null,2);await navigator.clipboard.writeText(value);setCopied(true);setTimeout(()=>setCopied(false),2000);}catch{setError('Không sao chép được. Bạn có thể chọn nội dung và sao chép thủ công.');}}
  async function save(){if(busy||applied)return;setBusy(true);setError('');try{const value=await saveAssistantDraft(draft.id,{kind:draft.kind,data} as AssistantDraft);setApplied(true);setEditing(false);await onSaved(draft.kind,value.id);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  return <section className="ai-draft"><header><span><FileText size={14}/>{labels[draft.kind]}</span><small>{applied?<><Check size={11}/>Đã lưu</>:'Chờ bạn kiểm tra'}</small></header>
    {editing?<div className="ai-draft-edit">{fields[draft.kind].map(field=><label key={field.key}>{field.label}{field.key==='priority'?<select value={get(field.key)} onChange={event=>set(field.key,event.target.value)}><option value="normal">Bình thường</option><option value="high">Cao</option></select>:field.type==='textarea'?<textarea value={get(field.key)} onChange={event=>set(field.key,event.target.value)} rows={field.key==='body'?9:4} maxLength={20000}/>:<input type={field.type||'text'} value={field.type==='datetime-local'?localDateTime(get(field.key)):get(field.key)} onChange={event=>set(field.key,field.type==='number'?Number(event.target.value):field.type==='datetime-local'?(event.target.value?event.target.value+':00+07:00':''):event.target.value||(['departureDate','deadline'].includes(field.key)?null:''))}/> }</label>)}</div>:<div className="ai-draft-preview">{(draft.kind==='template'||draft.kind==='reply')?<><strong>{get('name')||'Bản trả lời'}</strong><div className="ai-draft-subject">{get('subject')}</div><pre>{get('body')}</pre></>:<>{fields[draft.kind].map(field=><p key={field.key}><span>{field.label}</span><strong>{field.type==='datetime-local'?localDateTime(get(field.key)).replace('T',' '):get(field.key)||'Chưa có'}</strong></p>)}{draft.kind==='campaign'&&<p><span>Người nhận</span><strong>{(data.contactIds as string[]).length} liên hệ · Chỉ tạo bản nháp</strong></p>}</>}</div>}
    {error&&<p className="ai-draft-error" role="alert">{error}</p>}
    <footer><button type="button" className="ai-quiet-button" onClick={copy}>{copied?<Check size={13}/>:<Copy size={13}/>} {copied?'Đã chép':'Sao chép'}</button>{!applied&&<button type="button" className="ai-quiet-button" onClick={()=>setEditing(!editing)}>{editing?'Xem trước':'Chỉnh sửa'}</button>}{draft.kind!=='reply'&&!applied&&<button type="button" className="button primary small-button" disabled={busy} onClick={save}>{busy?<LoaderCircle size={13} className="spin"/>:<Check size={13}/>} {draft.kind==='template'?'Lưu vào thư viện':'Xác nhận lưu'}</button>}</footer>
  </section>;
}

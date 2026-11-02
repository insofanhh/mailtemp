import type {AssistantDraft} from './assistant-schema';

export type AppliedAssistantDraft={id:string;kind:string;alreadyApplied:boolean};

function connectionError(error:unknown){
  return error instanceof TypeError||(error instanceof DOMException&&['AbortError','TimeoutError','NetworkError'].includes(error.name));
}

// Reuse the exact draft and payload after a lost response. The server locks the
// draft and returns its existing entityId if the first request already committed.
export async function saveAssistantDraft(draftId:string,draft:AssistantDraft,request:typeof fetch=fetch):Promise<AppliedAssistantDraft>{
  const body=JSON.stringify({draftId,draft,confirmed:true});
  for(let attempt=0;attempt<2;attempt++){
    try{
      const response=await request('/api/assistant/actions',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(15000),
      });
      let value:unknown;
      try{value=await response.json();}
      catch(error){
        if(connectionError(error))throw error;
        if(response.status===401)throw new Error('Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi mở lịch sử trợ lý để tiếp tục lưu mẫu.');
        throw new Error('Máy chủ trả phản hồi không hợp lệ. Hãy tải lại trang và mở cuộc trò chuyện này để kiểm tra trạng thái bản nháp.');
      }
      const result=value as Partial<AppliedAssistantDraft>&{error?:string};
      if(!response.ok){
        if(response.status===401)throw new Error('Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi mở lịch sử trợ lý để tiếp tục lưu mẫu.');
        throw new Error(result?.error||'Không lưu được bản nháp. Vui lòng thử lại.');
      }
      if(!result||typeof result.id!=='string'||typeof result.kind!=='string'||typeof result.alreadyApplied!=='boolean')throw new Error('Chưa xác nhận được kết quả lưu. Hãy tải lại trang và mở cuộc trò chuyện này để kiểm tra trạng thái bản nháp.');
      return result as AppliedAssistantDraft;
    }catch(error){
      if(!connectionError(error))throw error;
      if(attempt===1)throw new Error('Mất kết nối hoặc máy chủ phản hồi quá chậm, chưa xác nhận được kết quả lưu. Bản nháp vẫn được giữ. Kiểm tra kết nối rồi bấm lưu lại; hệ thống sẽ không tạo mẫu trùng.');
      await new Promise(resolve=>setTimeout(resolve,400));
    }
  }
  throw new Error('Không lưu được bản nháp. Vui lòng thử lại.');
}

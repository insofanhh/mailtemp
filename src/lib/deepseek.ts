import {assistantOutputSchema} from './assistant-schema';
import {workspaceTool} from './assistant-context';

export type ModelMessage={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:ToolCall[];tool_call_id?:string};
type ToolCall={id:string;type:'function';function:{name:string;arguments:string}};
type ModelResponse={choices:{finish_reason:string;message:ModelMessage}[];usage?:{prompt_tokens:number;completion_tokens:number}};
export class AssistantError extends Error{constructor(public status:number,message:string){super(message);}}
export function assistantConfig(){return {enabled:process.env.AI_ENABLED!=='false'&&Boolean(process.env.DEEPSEEK_API_KEY),model:process.env.DEEPSEEK_MODEL||'deepseek-flash',dailyLimit:Math.max(1,Math.min(300,Number(process.env.AI_DAILY_REQUEST_LIMIT)||60))};}
export async function deepseekCompletion(messages:ModelMessage[],tools:boolean,signal:AbortSignal):Promise<ModelResponse>{
  if(!assistantConfig().enabled)throw new AssistantError(503,'Trợ lý chưa được cấu hình. Quản trị viên cần thêm DEEPSEEK_API_KEY trên máy chủ.');
  let response:Response;
  try{response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',signal,headers:{Authorization:'Bearer '+process.env.DEEPSEEK_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:assistantConfig().model,messages,stream:false,max_tokens:4200,temperature:0.3,thinking:{type:'disabled'},response_format:{type:'json_object'},...(tools?{tools:[workspaceTool]}:{})})});}
  catch{throw new AssistantError(504,'DeepSeek phản hồi chậm hoặc mất kết nối. Lịch sử đã được giữ; bạn có thể thử lại.');}
  if(!response.ok){
    const messages:Record<number,string>={400:'Model hoặc yêu cầu không được DeepSeek hỗ trợ. Kiểm tra DEEPSEEK_MODEL.',401:'API key DeepSeek không hợp lệ. Kiểm tra cấu hình máy chủ.',402:'Tài khoản DeepSeek chưa đủ số dư.',429:'DeepSeek đang giới hạn yêu cầu. Vui lòng thử lại sau.',503:'DeepSeek đang quá tải. Vui lòng thử lại sau.'};
    throw new AssistantError(response.status===429?429:502,messages[response.status]||'Không nhận được phản hồi hợp lệ từ DeepSeek.');
  }
  try{const data=await response.json();if(!Array.isArray(data.choices)||!data.choices[0]?.message)throw new Error();return data;}
  catch{throw new AssistantError(502,'DeepSeek trả dữ liệu không hợp lệ.');}
}
export function parseAssistantOutput(content:string|null){
  try{return assistantOutputSchema.parse(JSON.parse(content?.trim()||''));}
  catch{throw new AssistantError(502,'Trợ lý chưa tạo được bản nháp hợp lệ. Hãy nêu rõ nội dung, hoặc yêu cầu ít thay đổi hơn.');}
}

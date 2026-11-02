import {z} from 'zod';
import {requireUser,sameOrigin,HttpError} from '@/lib/auth';
import {assistantState,runAssistant} from '@/lib/assistant';
import {AssistantError} from '@/lib/deepseek';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=90;
async function handler(request:Request){try{
  if(request.method==='POST')sameOrigin(request);const user=await requireUser();
  if(request.method==='GET'){const id=new URL(request.url).searchParams.get('threadId');if(id&&!z.uuid().safeParse(id).success)throw new HttpError(400,'Mã cuộc trò chuyện không hợp lệ.');return Response.json(await assistantState(user,id||undefined),{headers:{'Cache-Control':'no-store'}});}
  if(Number(request.headers.get('content-length')||0)>70000)throw new HttpError(413,'Nội dung quá dài.');const raw=await request.text();if(raw.length>65000)throw new HttpError(413,'Nội dung quá dài.');
  return Response.json(await runAssistant(user,JSON.parse(raw)),{headers:{'Cache-Control':'no-store'}});
}catch(error){const known=error instanceof HttpError||error instanceof AssistantError;return Response.json({error:known?error.message:error instanceof z.ZodError?'Yêu cầu chưa hợp lệ. Kiểm tra độ dài nội dung và dữ liệu bản nháp.':'Không xử lý được trợ lý. Kiểm tra database và cấu hình máy chủ.'},{status:known?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'Cache-Control':'no-store'}});}}
export {handler as GET,handler as POST};

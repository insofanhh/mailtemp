import {z} from 'zod';
import {requireUser,sameOrigin,HttpError} from '@/lib/auth';
import {applyAssistantDraft} from '@/lib/assistant-actions';
export const runtime='nodejs';
export async function POST(request:Request){try{
  sameOrigin(request);const user=await requireUser();if(Number(request.headers.get('content-length')||0)>50000)throw new HttpError(413,'Bản nháp quá dài.');const raw=await request.text();if(raw.length>45000)throw new HttpError(413,'Bản nháp quá dài.');
  const body=z.object({draftId:z.uuid(),draft:z.unknown(),confirmed:z.literal(true)}).parse(JSON.parse(raw));
  return Response.json(await applyAssistantDraft(user,body.draftId,body.draft),{headers:{'Cache-Control':'no-store'}});
}catch(error){return Response.json({error:error instanceof HttpError?error.message:error instanceof z.ZodError?error.issues.map(issue=>issue.message).join(' '):'Không lưu được bản nháp. Kiểm tra dữ liệu và thử lại.'},{status:error instanceof HttpError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500});}}

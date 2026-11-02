import {requireUser,requireAdmin,sameOrigin,HttpError} from '@/lib/auth';
import {verifySmtp} from '@/lib/smtp';
import {setting} from '@/lib/activity';

export const runtime='nodejs';
export const maxDuration=120;
export async function POST(request:Request){
  try{
    sameOrigin(request);requireAdmin(await requireUser());
    const result=await verifySmtp();
    await setting('smtp_verified_at',new Date().toISOString());
    await setting('smtp_verify_status',result.ok?'success':'failed');
    await setting('smtp_verify_message',result.message);
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({error:error instanceof HttpError?error.message:'Không kiểm tra được kết nối SMTP.'},{status:error instanceof HttpError?error.status:500});}
}

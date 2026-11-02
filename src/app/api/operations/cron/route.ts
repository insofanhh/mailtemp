import {requireUser,requireAdmin,sameOrigin,HttpError} from '@/lib/auth';
import {recoverMailQueue} from '@/lib/mail-queue';
export const runtime='nodejs';
export const maxDuration=120;
export async function POST(request:Request){try{sameOrigin(request);requireAdmin(await requireUser());return Response.json(await recoverMailQueue(),{headers:{'Cache-Control':'no-store'}});}catch(error){return Response.json({error:error instanceof HttpError?error.message:'Không chạy được tác vụ.'},{status:error instanceof HttpError?error.status:500});}}

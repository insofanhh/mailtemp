import {requireUser,requireAdmin,sameOrigin,HttpError} from '@/lib/auth';
import {runCron} from '@/lib/worker';
export async function POST(request:Request){try{sameOrigin(request);requireAdmin(await requireUser());return Response.json(await runCron());}catch(error){return Response.json({error:error instanceof HttpError?error.message:'Không chạy được tác vụ.'},{status:error instanceof HttpError?error.status:500});}}

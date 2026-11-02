import {NextResponse} from 'next/server';
import {secretMatches} from '@/lib/auth';
import {runCron} from '@/lib/worker';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  const token=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';
  if(!secretMatches(token,process.env.CRON_SECRET))return NextResponse.json({error:'Unauthorized'},{status:401});
  try{return NextResponse.json(await runCron());}catch{console.error('Cron execution failed');return NextResponse.json({error:'Cron failed'},{status:500});}
}

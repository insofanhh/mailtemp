import {createHmac,timingSafeEqual} from 'node:crypto';
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {processEvent} from '@/lib/events';
export const runtime='nodejs';
export async function POST(request:Request){
  const raw=await request.text();if(raw.length>200000)return NextResponse.json({error:'Payload too large'},{status:413});
  const timestamp=request.headers.get('x-mailtemp-timestamp')||'',signature=request.headers.get('x-mailtemp-signature')||'',secret=process.env.WEBHOOK_SECRET;
  if(!secret||secret.length<32||!/^\d+$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300000)return NextResponse.json({error:'Unauthorized'},{status:401});
  const expected=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return NextResponse.json({error:'Unauthorized'},{status:401});
  try{
    const event=z.object({eventId:z.string().min(1).max(200),type:z.enum(['reply','delivered','hard_bounce','complaint','unsubscribe','ooo','heartbeat']),email:z.email().optional(),messageId:z.string().max(254).optional(),subject:z.string().max(500).optional(),body:z.string().max(100000).optional(),userId:z.uuid().optional(),receivedAt:z.iso.datetime({offset:true}).optional()}).refine(v=>v.type==='heartbeat'?Boolean(v.userId):Boolean(v.email)).parse(JSON.parse(raw));
    return NextResponse.json(await processEvent(event));
  }catch(error){if(error instanceof z.ZodError||error instanceof SyntaxError)return NextResponse.json({error:'Invalid event'},{status:400});console.error('Event processing failed');return NextResponse.json({error:'Event processing failed'},{status:500});}
}

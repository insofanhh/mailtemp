import {handleCallback} from '@vercel/queue';
import {consumeMailJob} from '@/lib/mail-queue';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
const callback=handleCallback(consumeMailJob,{
  visibilityTimeoutSeconds:300,
  retry:(_error,metadata)=>({afterSeconds:Math.min(60,5*metadata.deliveryCount)}),
});
export async function POST(request:Request){return callback(request);}

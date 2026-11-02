import {handleCallback} from '@vercel/queue';
import {consumeMailJob} from '@/lib/mail-queue';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
export const POST=handleCallback(consumeMailJob,{
  visibilityTimeoutSeconds:300,
  retry:(_error,metadata)=>({afterSeconds:Math.min(60,5*metadata.deliveryCount)}),
});

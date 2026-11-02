import {send} from '@vercel/queue';
import {rows} from './db';
import {setting} from './activity';
import {runDirectQueue} from './direct-mail';
import {runCron} from './worker';
import {createMailJobConsumer,publishRecovery,type JobPublisher} from './mail-jobs';

export const MAIL_TOPIC='mailtemp-delivery';
export const usesMailQueue=()=>process.env.VERCEL_ENV==='production';
export const publishMailJob:JobPublisher=async(job,idempotencyKey)=>{
  await send(MAIL_TOPIC,job,{retentionSeconds:86400,...(idempotencyKey?{idempotencyKey}:{})});
};

export async function enqueueDirectBatch(batchId:string){
  if(!usesMailQueue())return {state:'local' as const};
  try{
    await publishMailJob({kind:'direct',batchId});
    return {state:'queued' as const};
  }catch{
    await setting('mail_queue_error','Không kích hoạt được tác vụ gửi; cron sẽ thử khôi phục hàng đợi.');
    return {state:'deferred' as const,warning:'Đã lưu lượt gửi. Chưa kích hoạt được worker; hệ thống sẽ thử lại qua cron.'};
  }
}

export const consumeMailJob=createMailJobConsumer({
  direct:batchId=>runDirectQueue({batchId}),
  scheduled:runCron,
  pending:async batchId=>!!(await rows("SELECT r.id FROM direct_mail_recipients r JOIN direct_mail_batches b ON b.id=r.batchId WHERE b.id=? AND b.status IN ('queued','running') AND r.status='pending' LIMIT 1",[batchId])).length,
  publish:publishMailJob,
});

export async function recoverMailQueue(){
  if(!usesMailQueue()){
    const direct=await runDirectQueue();
    return {...await runCron(),direct};
  }
  try{
    // Include interrupted sends so the consumer can move abandoned claims to
    // unknown even if a batch has no remaining pending recipients.
    const batches=await rows("SELECT b.id FROM direct_mail_batches b WHERE b.status IN ('queued','running') AND EXISTS(SELECT 1 FROM direct_mail_recipients r WHERE r.batchId=b.id AND r.status IN ('pending','sending')) ORDER BY b.createdAt LIMIT 100");
    const result=await publishRecovery(batches.map(b=>String(b.id)),publishMailJob);
    await setting('last_queue_recovery_at',new Date().toISOString());
    await setting('mail_queue_error','');
    return result;
  }catch(error){
    await setting('mail_queue_error','Không đưa được tác vụ vào hàng đợi. Kiểm tra Vercel Queues và lần gọi cron tiếp theo.');
    throw error;
  }
}

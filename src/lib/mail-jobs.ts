import {z} from 'zod';

export const mailJobSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('direct'),batchId:z.uuid()}).strict(),
  z.object({kind:z.literal('scheduled')}).strict(),
]);
export type MailJob=z.infer<typeof mailJobSchema>;
export type JobPublisher=(job:MailJob,key?:string)=>Promise<void>;

// Queue delivery is at least once. TiDB claims, rather than queue message IDs,
// decide whether an SMTP transaction may begin.
export function createMailJobConsumer(deps:{
  direct:(batchId:string)=>Promise<{busy:boolean;blocked:string|null}>;
  scheduled:()=>Promise<unknown>;
  pending:(batchId:string)=>Promise<boolean>;
  publish:JobPublisher;
}){
  return async(payload:unknown)=>{
    const job=mailJobSchema.parse(payload);
    if(job.kind==='scheduled'){await deps.scheduled();return;}
    const result=await deps.direct(job.batchId);
    if(result.busy)throw new Error('DIRECT_WORKER_BUSY');
    if(!result.blocked&&await deps.pending(job.batchId))await deps.publish(job);
  };
}

export async function publishRecovery(batchIds:string[],publish:JobPublisher,minute=Math.floor(Date.now()/60_000)){
  // A failed publish must fail cron visibly. Already published jobs are safe to
  // publish again, including when the scheduler repeats the same request.
  for(const batchId of batchIds)await publish({kind:'direct',batchId},`recover:${batchId}:${minute}`);
  await publish({kind:'scheduled'},`scheduled:${minute}`);
  return {queued:true,directBatches:batchIds.length,processed:0};
}

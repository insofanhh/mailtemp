import {z} from 'zod';
import {templateSchema,taskSchema,rfqSchema,quoteSchema,campaignSchema} from './schemas';

export const templateVariables=['contact_name','company_name','sender_name','tour_name','duration','price','unit','valid_until','conditions'] as const;
export function unknownTemplateVariables(text:string){
  const names=[...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match=>match[1]);
  return [...new Set(names.filter(name=>!templateVariables.includes(name as typeof templateVariables[number])))];
}
export const assistantTemplateSchema=templateSchema.refine(data=>unknownTemplateVariables(data.subject+'\n'+data.body).length===0,'Mẫu chứa biến chưa được hỗ trợ.');
export const draftSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('template'),data:assistantTemplateSchema}),
  z.object({kind:z.literal('reply'),data:z.object({subject:z.string().trim().min(1).max(400),body:z.string().trim().min(1).max(20000)})}),
  z.object({kind:z.literal('task'),data:taskSchema}),
  z.object({kind:z.literal('rfq'),data:rfqSchema}),
  z.object({kind:z.literal('quote'),data:quoteSchema}),
  z.object({kind:z.literal('campaign'),data:campaignSchema}),
]);
export type AssistantDraft=z.infer<typeof draftSchema>;
export const assistantOutputSchema=z.object({
  answer:z.string().trim().min(1).max(20000),
  drafts:z.array(draftSchema).max(3).default([]),
  suggestions:z.array(z.string().trim().min(1).max(200)).max(3).default([]),
});
export const assistantViews=['dashboard','accounts','contacts','products','templates','campaigns','direct-mail','inbox','rfqs','tasks','settings'] as const;
export const entityTypes=['account','contact','product','template','campaign','task','rfq','quote','message'] as const;
export const assistantRequestSchema=z.object({
  requestId:z.uuid(),threadId:z.uuid().optional(),message:z.string().trim().min(1).max(16000),
  useWorkspace:z.boolean().default(true),view:z.enum(assistantViews).default('dashboard'),
  context:z.object({type:z.enum(entityTypes),id:z.uuid()}).optional(),
});
export const assistantToolSchema=z.object({
  resource:z.enum(['summary','accounts','contacts','products','templates','campaigns','tasks','rfqs','quotes','messages','operations']),
  query:z.string().max(120).default(''),id:z.uuid().optional(),status:z.string().max(40).optional(),
}).strict();
export type AssistantSource={type:string;id:string;label:string;view:string};
export type SavedDraft=AssistantDraft & {id:string;status:'pending'|'applied';entityId:string|null};
export type AssistantMessage={id:string;role:'user'|'assistant';content:string;createdAt:string;suggestions?:string[];sources?:AssistantSource[];drafts?:SavedDraft[]};

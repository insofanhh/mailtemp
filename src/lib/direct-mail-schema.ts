import {z} from 'zod';
export const directMailSchema=z.object({
  name:z.string().trim().min(1).max(200),
  ownerId:z.uuid().optional(),
  templateId:z.union([z.uuid(),z.literal('')]).nullish().transform(v=>v||null),
  allowTemplateResend:z.boolean().default(false),
  subject:z.string().trim().min(1).max(400).refine(v=>!/[\r\n]/.test(v),'Tiêu đề không được xuống dòng.'),
  body:z.string().trim().min(1).max(20000),
  productId:z.union([z.uuid(),z.literal('')]).nullish().transform(v=>v||null),
  recipientPolicy:z.enum(['eligible_only','include_unreviewed']).default('include_unreviewed'),
  contactIds:z.array(z.uuid()).min(1).max(1000).transform(v=>[...new Set(v)].sort()),
});
export type DirectMailInput=z.infer<typeof directMailSchema>;
export const directStartSchema=z.object({input:directMailSchema,requestId:z.uuid(),previewToken:z.string().length(64),acceptExclusions:z.boolean().default(false),acceptDuplicateRisk:z.boolean().default(false)});
export const directRetrySchema=z.object({recipientId:z.uuid(),reason:z.string().trim().min(20).max(2000),acceptDuplicateRisk:z.literal(true)});

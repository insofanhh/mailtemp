import {z} from 'zod';

export const webmailSchema=z.object({
  email:z.email().max(254).transform(value=>value.toLowerCase()),
  host:z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,'Nhập hostname IMAP, không gồm https:// hoặc đường dẫn.'),
  port:z.literal(993).default(993),
  username:z.string().trim().min(1).max(254).regex(/^[^\r\n\x00]+$/),
  password:z.string().min(1,'Nhập mật khẩu hộp thư.').max(1024).regex(/^[^\r\n\x00]+$/),
}).strict();
export type WebmailInput=z.infer<typeof webmailSchema>;

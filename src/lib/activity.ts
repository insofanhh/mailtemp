import { randomUUID } from 'node:crypto';
import { run, type DB } from './db';
export async function audit(actorId: string | null, action: string, entityType: string, entityId: string | null, details: unknown = {}, db?: DB) {
  await run('INSERT INTO audit_logs(id,actorId,action,entityType,entityId,details) VALUES (?,?,?,?,?,?)',[randomUUID(),actorId,action,entityType,entityId,JSON.stringify(details)],db);
}
export async function notify(userId: string | null,title: string,body = '',kind='info',db?: DB) {
  await run('INSERT INTO notifications(userId,title,body,kind) VALUES (?,?,?,?)',[userId,title,body,kind],db);
}
export async function setting(key: string, value: string, db?: DB) {
  await run('INSERT INTO settings(settingKey,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)',[key,value],db);
}

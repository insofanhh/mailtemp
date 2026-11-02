import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { rows, run } from './db';

import { COOKIE, hash, userFromToken, type User } from './session';
export { COOKIE, hash, userFromToken, type User } from './session';
export function secretMatches(a: string, b: string | undefined) { return Boolean(b && b.length >= 32 && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))); }
export async function currentUser() { return userFromToken((await cookies()).get(COOKIE)?.value); }
export async function requireUser() {
  const user = await currentUser(); if (!user) throw new HttpError(401, 'Vui lòng đăng nhập.'); return user;
}
export class HttpError extends Error { constructor(public status: number, message: string) {super(message);} }
export function requireAdmin(user: User) { if (user.role !== 'admin') throw new HttpError(403,'Chỉ quản trị viên được thực hiện thao tác này.'); }
export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex');
  await run('INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 12 HOUR))',[hash(token),userId]);
  (await cookies()).set(COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:43200});
}
export function sameOrigin(request: Request) {
  const allowed = new URL(process.env.APP_URL || 'http://localhost:3000').origin;
  if (request.headers.get('origin') !== allowed) throw new HttpError(403,'Yêu cầu không cùng nguồn.');
}
export async function ownAccount(user: User, id: string, db?: Parameters<typeof rows>[2]) {
  const result = await rows('SELECT * FROM accounts WHERE id=? AND deletedAt IS NULL'+(db?' FOR UPDATE':''),[id],db);
  if (!result[0]) throw new HttpError(404,'Không tìm thấy đại lý.');
  if (user.role !== 'admin' && result[0].ownerId !== user.id) throw new HttpError(403,'Đại lý thuộc sale khác.');
  return result[0];
}

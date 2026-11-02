import { createHash } from 'node:crypto';
import { rows } from './db';

export type User = { id: string; name: string; email: string; role: 'admin' | 'sale' };
export const COOKIE = 'mailtemp_session';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function userFromToken(token?: string): Promise<User | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const found = await rows('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.userId WHERE s.tokenHash=? AND s.expiresAt>UTC_TIMESTAMP(3) AND u.active=TRUE', [hash(token)]);
  return (found[0] as User | undefined) ?? null;
}

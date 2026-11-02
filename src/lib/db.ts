import mysql, {type PoolConnection, type RowDataPacket, type ResultSetHeader} from 'mysql2/promise';
import {databasePoolOptions} from './db-config';

const globalDb = globalThis as unknown as { mailtempPool?: mysql.Pool };
export function pool() {
  if (!globalDb.mailtempPool) globalDb.mailtempPool = mysql.createPool(databasePoolOptions(process.env.DATABASE_URL));
  return globalDb.mailtempPool;
}
export type DB = mysql.Pool | PoolConnection;
type SqlValue = string | number | boolean | Date | null | Buffer;
export async function rows<T extends RowDataPacket = RowDataPacket>(sql: string, params: SqlValue[] = [], db: DB = pool()): Promise<T[]> {
  const [result] = await db.execute<T[]>(sql, params);
  return result;
}
export async function run(sql: string, params: SqlValue[] = [], db: DB = pool()) {
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return result;
}
export async function transaction<T>(fn: (db: PoolConnection) => Promise<T>) {
  const db = await pool().getConnection();
  try { await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await db.beginTransaction(); const result = await fn(db); await db.commit(); return result; }
  catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}
export function sqlDate(value: string | Date) { return new Date(value).toISOString().slice(0,23).replace('T',' '); }

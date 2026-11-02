import type {PoolOptions} from 'mysql2/promise';

export function databasePoolOptions(value: string | undefined): PoolOptions {
  if (!value) throw new Error('Chưa cấu hình DATABASE_URL.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('DATABASE_URL không đúng định dạng mysql://user:password@host:port/database.'); }
  if (url.protocol !== 'mysql:' || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('DATABASE_URL cần dùng mysql:// và có tên database.');
  }
  let username: string, password: string;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error('Username/password trong DATABASE_URL có ký tự URL encode không hợp lệ.'); }
  if (/^(USERNAME|YOUR_USERNAME|CHANGE_ME)$/i.test(username) || /^(PASSWORD|YOUR_PASSWORD|CHANGE_ME)$/i.test(password)) {
    throw new Error('DATABASE_URL vẫn chứa USERNAME/PASSWORD mẫu. Hãy sao chép username và password thật từ TiDB > Connect; username Starter bao gồm tiền tố instance.');
  }
  const tidb = url.hostname.endsWith('.tidbcloud.com');
  if (tidb && /^gateway\d+\./.test(url.hostname) && !/^[^.]+\..+$/.test(username)) {
    throw new Error('Username TiDB Starter thiếu tiền tố instance. Sao chép đầy đủ username từ TiDB > Connect, ví dụ <prefix>.root.');
  }
  if (tidb && !url.searchParams.has('ssl')) {
    url.searchParams.set('ssl', JSON.stringify({rejectUnauthorized: true}));
  }
  if (tidb) {
    let ssl: unknown;
    try { ssl = JSON.parse(url.searchParams.get('ssl')!); }
    catch { throw new Error('Cấu hình TLS TiDB không hợp lệ. Bỏ tham số ssl để ứng dụng tự bật TLS xác thực chứng chỉ.'); }
    if (!ssl || typeof ssl !== 'object' || Array.isArray(ssl) || ('rejectUnauthorized' in ssl && ssl.rejectUnauthorized !== true)) {
      throw new Error('TiDB yêu cầu TLS xác thực chứng chỉ. Bỏ tham số ssl để ứng dụng tự cấu hình an toàn.');
    }
  }
  return {uri: url.toString(), connectionLimit: 8, timezone: 'Z', dateStrings: true, decimalNumbers: true, charset: 'utf8mb4'};
}

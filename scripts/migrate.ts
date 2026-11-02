import nextEnv from '@next/env';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {pool,run} from '../src/lib/db';
import {databasePoolOptions} from '../src/lib/db-config';
import {backfillTemplateHistory} from '../src/lib/template-history';
nextEnv.loadEnvConfig(process.cwd());
let database: ReturnType<typeof pool> | undefined;
let step='kiểm tra cấu hình';
try{
  databasePoolOptions(process.env.DATABASE_URL);
  if(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length<12)throw new Error('ADMIN_PASSWORD cần ít nhất 12 ký tự. Chưa thay đổi database; hãy sửa mật khẩu rồi chạy lại.');
  database=pool();
  await database.query('SELECT 1');
  console.log('Đã kết nối database. Đang cập nhật bảng...');
  for(const statement of readFileSync('db/schema.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean)){
    step='tạo bảng '+(statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]||'schema');
    await database.query(statement);
  }
  step='cập nhật cột và index';
  const [columns]=await pool().query("SHOW COLUMNS FROM accounts LIKE 'deletedAt'");
  if(!(columns as unknown[]).length)await pool().query('ALTER TABLE accounts ADD COLUMN deletedAt DATETIME(3) NULL');
  const [policyColumns]=await pool().query("SHOW COLUMNS FROM campaigns LIKE 'recipientPolicy'");
  if(!(policyColumns as unknown[]).length)await pool().query("ALTER TABLE campaigns ADD COLUMN recipientPolicy VARCHAR(40) NOT NULL DEFAULT 'eligible_only'");
  const [productColumns]=await pool().query("SHOW COLUMNS FROM campaigns LIKE 'productId'");
  if((productColumns as {Null:string}[])[0]?.Null==='NO')await pool().query('ALTER TABLE campaigns MODIFY COLUMN productId CHAR(36) NULL');
  for(const [name,definition] of [['retryAuthorizedAt','DATETIME(3) NULL'],['retryAuthorizedBy','CHAR(36) NULL'],['retryReason','VARCHAR(2000) NULL'],['retryConsumedBy','CHAR(36) NULL']]){
    const [existing]=await pool().query('SHOW COLUMNS FROM direct_mail_recipients LIKE ?',[name]);
    if(!(existing as unknown[]).length)await pool().query(`ALTER TABLE direct_mail_recipients ADD COLUMN ${name} ${definition}`);
  }
  const [emailIndex]=await pool().query("SHOW INDEX FROM direct_mail_recipients WHERE Key_name='direct_email_status'");
  if(!(emailIndex as unknown[]).length)await pool().query('ALTER TABLE direct_mail_recipients ADD INDEX direct_email_status(email,status)');
  step='cập nhật cột lịch sử mẫu thư';
  for(const [table,columns] of Object.entries({
    campaigns:[['allowTemplateResend','BOOLEAN NOT NULL DEFAULT FALSE']],
    direct_mail_batches:[['templateId','CHAR(36) NULL'],['templateKey','CHAR(64) NULL'],['contentKey','CHAR(64) NULL'],['allowTemplateResend','BOOLEAN NOT NULL DEFAULT FALSE']],
    campaign_recipients:[['emailSnapshot','VARCHAR(254) NULL'],['templateKey','CHAR(64) NULL'],['contentKey','CHAR(64) NULL']],
  }))for(const [name,definition] of columns){
    const [existing]=await pool().query(`SHOW COLUMNS FROM ${table} LIKE ?`,[name]);
    if(!(existing as unknown[]).length)await pool().query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  const [historyIndex]=await pool().query("SHOW INDEX FROM campaign_recipients WHERE Key_name='campaign_email_template'");
  if(!(historyIndex as unknown[]).length)await pool().query('ALTER TABLE campaign_recipients ADD INDEX campaign_email_template(emailSnapshot,templateKey,status)');
  step='cập nhật lịch sử mẫu thư';
  await backfillTemplateHistory();
  step='tạo tài khoản admin';
  if(process.env.ADMIN_PASSWORD){
    const inserted=await run('INSERT IGNORE INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[randomUUID(),'Quản trị viên',process.env.ADMIN_EMAIL||'admin@mailtemp.local',await bcrypt.hash(process.env.ADMIN_PASSWORD,12),'admin']);
    console.log(inserted.affectedRows?'Đã tạo tài khoản admin theo ADMIN_EMAIL.':'Email admin đã tồn tại; giữ nguyên tài khoản và mật khẩu hiện có.');
  }else console.log('Chưa tạo admin vì thiếu ADMIN_PASSWORD. Đặt ADMIN_EMAIL và ADMIN_PASSWORD rồi chạy lại để tạo tài khoản.');
  step='khởi tạo thiết lập';
  await run("INSERT IGNORE INTO settings(settingKey,value) VALUES ('daily_limit','20'),('signature','Đội ngũ kinh doanh du lịch'),('sender_address',''),('emergency_stop','false')");
  console.log('Schema đã cập nhật thành công.');
}catch(error){
  const code=(error as {code?:string}).code;
  const messages:Record<string,string>={
    ER_ACCESS_DENIED_ERROR:'TiDB/MySQL từ chối đăng nhập. Kiểm tra username đầy đủ và password trong DATABASE_URL.',
    ER_BAD_DB_ERROR:'Database chưa tồn tại. Tạo database mailtemp trong TiDB SQL Editor rồi chạy lại.',
    ER_PARSE_ERROR:'Cú pháp schema không tương thích với database. Cập nhật mã nguồn migration mới nhất rồi chạy lại.',
    ENOTFOUND:'Không tìm thấy máy chủ database. Kiểm tra hostname trong DATABASE_URL.',
    ETIMEDOUT:'Kết nối database hết thời gian chờ. Kiểm tra mạng và endpoint TiDB.',
    ECONNREFUSED:'Máy chủ từ chối kết nối. Kiểm tra hostname và port database.'
  };
  const fallback=error instanceof Error?error.message:'Không thể chạy migration.';
  const message=code?(messages[code]||`Migration thất bại (${code}). Kiểm tra kết nối và quyền tạo/cập nhật bảng.`):fallback;
  console.error('Lỗi migration ('+step+'): '+message);
  process.exitCode=1;
}finally{if(database)await database.end();}

import nextEnv from '@next/env';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {pool,run} from '../src/lib/db';
nextEnv.loadEnvConfig(process.cwd());
try{
  for(const statement of readFileSync('db/schema.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean))await pool().query(statement);
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
  if(process.env.ADMIN_PASSWORD&&process.env.ADMIN_PASSWORD.length>=12)await run('INSERT IGNORE INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[randomUUID(),'Quản trị viên',process.env.ADMIN_EMAIL||'admin@mailtemp.local',await bcrypt.hash(process.env.ADMIN_PASSWORD,12),'admin']);
  await run("INSERT IGNORE INTO settings(settingKey,value) VALUES ('daily_limit','20'),('signature','Đội ngũ kinh doanh du lịch'),('sender_address',''),('emergency_stop','false')");
  console.log('Schema đã cập nhật. Admin chỉ được tạo nếu chưa tồn tại và có ADMIN_PASSWORD hợp lệ.');
}finally{await pool().end();}

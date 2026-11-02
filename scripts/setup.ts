import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import nextEnv from '@next/env';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

async function main() {
  if(!existsSync('.env.local')) {
    const password=randomBytes(18).toString('base64url');
    const dbPassword=randomBytes(24).toString('hex');
    const env=readFileSync('.env.example','utf8')
      .replace('mailtemp_app:CHANGE_ME','mailtemp_app:'+dbPassword)
      .replace('CHANGE_TO_A_RANDOM_PASSWORD',password)
      .replaceAll('GENERATE_AT_LEAST_32_RANDOM_CHARACTERS',()=>randomBytes(32).toString('hex'));
    writeFileSync('.env.local',env,{mode:0o600});
    writeFileSync('LOCAL_ACCESS.md',`# Truy cập local\n\nURL: http://localhost:3000\n\nEmail: admin@mailtemp.local\n\nMật khẩu: ${password}\n\nThông tin này chỉ dành cho máy local. Đổi mật khẩu và URL trước khi triển khai. Không commit tệp này.\n`,{mode:0o600});
  }
  nextEnv.loadEnvConfig(process.cwd());
  const url=new URL(process.env.DATABASE_URL!);
  const database=url.pathname.slice(1);
  if(!/^[a-zA-Z0-9_]+$/.test(database)||!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12) throw new Error('Tên database hoặc mật khẩu admin không hợp lệ.');
  const root=await mysql.createConnection(process.env.MYSQL_ROOT_URL || 'mysql://root@127.0.0.1:3306');
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const appUser=decodeURIComponent(url.username), appPassword=decodeURIComponent(url.password);
  if(appUser!=='root') {
    await root.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?',[appUser,'localhost',appPassword]);
    await root.query(`GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON \`${database}\`.* TO ?@?`,[appUser,'localhost']);
  }
  await root.end();
  const db=await mysql.createConnection({uri:process.env.DATABASE_URL,timezone:'Z'});
  const statements=readFileSync('db/schema.sql','utf8').split(';').map(x=>x.trim()).filter(Boolean);
  for(const statement of statements) await db.query(statement);
  const passwordHash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
  await db.execute('INSERT IGNORE INTO users(id,name,email,passwordHash,role) VALUES (?,?,?,?,?)',[randomUUID(),'Quản trị viên',process.env.ADMIN_EMAIL || 'admin@mailtemp.local',passwordHash,'admin']);
  await db.execute("INSERT IGNORE INTO settings(settingKey,value) VALUES ('daily_limit','20'),('signature','Đội ngũ kinh doanh du lịch'),('sender_address',''),('emergency_stop','false')");
  await db.end();
  mkdirSync('storage',{recursive:true});
  console.log('Đã chuẩn bị MySQL và tài khoản admin. Thông tin truy cập nằm trong LOCAL_ACCESS.md (nếu setup tự sinh cấu hình). SMTP vẫn tắt.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

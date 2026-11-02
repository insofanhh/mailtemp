import nextEnv from '@next/env';
import { randomUUID } from 'node:crypto';
nextEnv.loadEnvConfig(process.cwd());
const {rows,run,pool}=await import('../src/lib/db');

async function main() {
  const [admin]=await rows("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if(!admin) throw new Error('Chạy db:setup trước.');
  const [existing]=await rows("SELECT settingKey FROM settings WHERE settingKey='demo_seed'");
  if(existing) {console.log('Dữ liệu minh họa đã tồn tại.');return;}
  const names=[['Mẫu · An Việt Travel','Hà Nội','Khách đoàn','new'],['Mẫu · Saigon Journey','TP. Hồ Chí Minh','MICE','qualified'],['Mẫu · Miền Trung Holidays','Đà Nẵng','Tour ghép','new'],['Mẫu · Lotus DMC','Hà Nội','Inbound','qualified'],['Mẫu · Biển Xanh Travel','Nha Trang','Khách đoàn','new'],['Mẫu · Mekong Partners','Cần Thơ','Tour ghép','new']];
  const accountIds=[];
  for(let i=0;i<names.length;i++) {
    const id=randomUUID();accountIds.push(id);
    await run('INSERT INTO accounts(id,name,region,segment,stage,ownerId,website,notes) VALUES (?,?,?,?,?,?,?,?)',[id,...names[i],admin.id,`https://agency-${i+1}.example.com`,'Dữ liệu minh họa. Không sử dụng để gửi email.']);
    await run('INSERT INTO contacts(id,accountId,name,email,title,source,consentStatus) VALUES (?,?,?,?,?,?,?)',[randomUUID(),id,['Nguyễn Minh Anh','Trần Hoàng Nam','Lê Thu Hà','Phạm Ngọc Linh','Đỗ Quang Huy','Vũ Khánh Ly'][i],`demo-${i+1}@example.com`,'Phòng điều hành','Dữ liệu minh họa / example.com','unreviewed']);
  }
  const until=new Date();until.setMonth(until.getMonth()+3);
  for(const [name,destination,duration,price] of [['Hà Nội – Hạ Long – Ninh Bình','Miền Bắc','4 ngày 3 đêm',3850000],['Đà Nẵng – Hội An – Bà Nà','Miền Trung','3 ngày 2 đêm',2950000],['Phú Quốc · Biển & nghỉ dưỡng','Phú Quốc','3 ngày 2 đêm',4250000]] as const) {
    await run('INSERT INTO products(id,name,destination,duration,price,validUntil,conditions) VALUES (?,?,?,?,?,?,?)',[randomUUID(),name,destination,duration,price,until.toISOString().slice(0,10),'BẢNG GIÁ MINH HỌA. Giá net/khách, từ 20 khách. Chưa gồm vé máy bay và phụ thu lễ. Tình trạng dịch vụ cần xác nhận lại.']);
  }
  for(const [name,subject,body] of [
    ['Giới thiệu tuyến miền Bắc','[QC] Chương trình {{tour_name}} dành cho {{company_name}}','Chào {{contact_name}},\n\nEm là {{sender_name}}, phụ trách hỗ trợ đối tác. Xin gửi anh/chị chương trình {{tour_name}}, thời lượng {{duration}}.\n\nGiá tham khảo: {{price}}/{{unit}}. Hiệu lực đến {{valid_until}}.\n{{conditions}}\n\nAnh/chị có đoàn dự kiến cần bên em lên phương án không ạ?\n\nTrân trọng,\n{{sender_name}}'],
    ['Gửi chương trình theo yêu cầu','Chương trình {{tour_name}} theo yêu cầu của {{company_name}}','Chào {{contact_name}},\n\nTheo yêu cầu của anh/chị, em gửi thông tin {{tour_name}}.\n{{conditions}}\n\nAnh/chị cho em xin ngày đi và số khách để chuẩn bị báo giá phù hợp.\n\n{{sender_name}}'],
    ['Cập nhật sản phẩm mới','[QC] Cập nhật sản phẩm dành cho đối tác {{company_name}}','Chào {{contact_name}},\n\nBên em cập nhật chương trình {{tour_name}} – {{duration}}. Giá tham khảo {{price}}/{{unit}}, đến {{valid_until}}.\n\n{{conditions}}\n\nNếu phù hợp kế hoạch của đại lý, anh/chị có thể phản hồi email này để trao đổi thêm.\n\n{{sender_name}}']
  ]) await run('INSERT INTO templates(id,name,subject,body) VALUES (?,?,?,?)',[randomUUID(),name,subject,body]);
  for(let i=0;i<4;i++) await run('INSERT INTO tasks(id,title,accountId,ownerId,dueAt,priority) VALUES (?,?,?,?,?,?)',[randomUUID(),['Xác minh nguồn dữ liệu đại lý','Hoàn thiện hồ sơ đối tác MICE','Rà soát chương trình miền Trung','Chuẩn bị form đăng ký nhận bảng giá'][i],accountIds[i],admin.id,new Date(Date.now()+(i-1)*86400000).toISOString().slice(0,23).replace('T',' '),i===0?'high':'normal']);
  await run("INSERT INTO settings(settingKey,value) VALUES ('demo_seed','true')");
  await run('INSERT INTO notifications(userId,title,body,kind) VALUES (?,?,?,?)',[admin.id,'Không gian làm việc đã sẵn sàng','Dữ liệu minh họa được đánh dấu Mẫu. SMTP chưa cấu hình; chưa có thư nào được gửi.','success']);
  console.log('Đã thêm dữ liệu minh họa; tất cả liên hệ đều chưa được duyệt gửi.');
}
try {await main();} finally {await pool().end();}

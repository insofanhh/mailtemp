import {createHash,randomUUID} from 'node:crypto';
import {rows,run,transaction,type DB} from './db';
import {HttpError,type User} from './auth';
import {importRowSchema} from './schemas';
import {audit,notify} from './activity';
import {IMPORT_CHUNK_SIZE,IMPORT_MAX_ROWS,importFields,importKey,normalizeImportRecord,type ImportRecord,type MappedImportRow,type ImportProgress} from './import-data';

const chunks=<T>(items:T[],size=IMPORT_CHUNK_SIZE)=>Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size));
const marks=(count:number)=>Array.from({length:count},()=>'?').join(',');
const label=(key:string)=>importFields.find(field=>field.key===key)?.label||key;

export async function previewImport(user:User,filename:string,input:MappedImportRow[]){
  if(!input.length||input.length>IMPORT_MAX_ROWS)throw new HttpError(400,'Tệp cần có từ 1 đến 20.000 dòng dữ liệu sau dòng tiêu đề.');
  const records:ImportRecord[]=[],errors:{row:number;error:string}[]=[],seen=new Set<string>();let errorTotal=0;
  for(const item of input){
    const parsed=importRowSchema.safeParse(normalizeImportRecord(item.data));
    let error='';if(!parsed.success)error=parsed.error.issues.map(issue=>label(String(issue.path[0]))+': '+issue.message).join('; ');
    else if(seen.has(parsed.data.email))error='Email trùng trong tệp.';
    else{seen.add(parsed.data.email);records.push(parsed.data);}
    if(error){errorTotal++;if(errors.length<200)errors.push({row:item.row,error});}
  }
  const existing=new Set<string>(),foreign=new Set<string>();
  for(const group of chunks(records))for(const item of await rows(`SELECT email FROM contacts WHERE email IN (${marks(group.length)})`,group.map(record=>record.email)))existing.add(item.email.toLowerCase());
  const names=[...new Set(records.map(record=>record.company).filter(Boolean))];
  for(const group of chunks(names))for(const item of await rows(`SELECT name,ownerId FROM accounts WHERE deletedAt IS NULL AND name IN (${marks(group.length)})`,group))if(item.ownerId!==user.id)foreign.add(importKey(item.name));
  const available=records.filter(record=>!existing.has(record.email));const conflicts=available.filter(record=>foreign.has(importKey(record.company))).length;
  return {filename,records:available.filter(record=>!foreign.has(importKey(record.company))),errors,errorTotal,duplicates:existing.size,conflicts,total:input.length};
}

// Query in groups, rather than making four database round trips per contact.
async function writeRecords(user:User,records:ImportRecord[],db:DB){
  await run("INSERT IGNORE INTO settings(settingKey,value) VALUES ('contacts_import_lock','1')",[],db);
  await rows("SELECT settingKey FROM settings WHERE settingKey='contacts_import_lock' FOR UPDATE",[],db);
  let imported=0,skipped=0;
  for(const group of chunks(records)){
    const duplicate=new Set((await rows(`SELECT email FROM contacts WHERE email IN (${marks(group.length)})`,group.map(record=>record.email),db)).map(item=>item.email.toLowerCase()));
    const seen=new Set<string>(),available=group.filter(record=>{if(duplicate.has(record.email)||seen.has(record.email)){skipped++;return false;}seen.add(record.email);return true;});
    if(!available.length)continue;
    const names=[...new Set(available.map(record=>record.company).filter(Boolean))];
    const existing=names.length?await rows(`SELECT id,name,ownerId FROM accounts WHERE deletedAt IS NULL AND name IN (${marks(names.length)}) ORDER BY createdAt,id FOR UPDATE`,names,db):[];
    const accountMap=new Map<string,{id:string;ownerId:string}>(),foreign=new Set<string>();
    for(const account of existing){const key=importKey(account.name);if(account.ownerId!==user.id)foreign.add(key);if(!accountMap.has('company:'+key))accountMap.set('company:'+key,{id:account.id,ownerId:account.ownerId});}
    const accepted=available.filter(record=>{if(foreign.has(importKey(record.company))){skipped++;return false;}return true;});
    const accountKey=(record:ImportRecord)=>record.company?'company:'+importKey(record.company):'email:'+record.email;
    // Each contact without a company gets a separate blank profile, so adding its company later does not change unrelated contacts.
    const newAccounts:ImportRecord[]=[],newIds:string[]=[];
    for(const record of accepted){const key=accountKey(record);if(!accountMap.has(key)){const id=randomUUID();accountMap.set(key,{id,ownerId:user.id});newAccounts.push(record);newIds.push(id);}}
    if(newAccounts.length)await run(`INSERT INTO accounts(id,name,website,region,market,segment,tier,notes,ownerId) VALUES ${newAccounts.map(()=>'(?,?,?,?,?,?,?,?,?)').join(',')}`,newAccounts.flatMap((record,i)=>[newIds[i],record.company,record.website,record.region,record.market,record.segment,record.tier,record.notes,user.id]),db);
    if(!accepted.length)continue;
    const suppressed=new Set((await rows(`SELECT email FROM suppressions WHERE email IN (${marks(accepted.length)})`,accepted.map(record=>record.email),db)).map(item=>item.email.toLowerCase()));
    const result=await run(`INSERT IGNORE INTO contacts(id,accountId,name,email,title,source,country,consentStatus) VALUES ${accepted.map(()=>'(?,?,?,?,?,?,?,?)').join(',')}`,accepted.flatMap(record=>[randomUUID(),accountMap.get(accountKey(record))!.id,record.name,record.email,record.title,record.source,record.country,suppressed.has(record.email)?'suppressed':'unreviewed']),db);
    imported+=result.affectedRows;skipped+=accepted.length-result.affectedRows;
  }
  return {imported,skipped};
}

async function finishImport(user:User,id:string,filename:string,imported:number,skipped:number,db:DB){
  await run('INSERT INTO import_batches(id,actorId,filename,imported,skipped) VALUES (?,?,?,?,?)',[id,user.id,filename,imported,skipped],db);
  await audit(user.id,'contacts_imported','import',id,{imported,skipped},db);
  await notify(user.id,'Đã nhập dữ liệu',`${imported} liên hệ mới, ${skipped} bỏ qua. Liên hệ mới cần được đánh giá quyền gửi.`,'success',db);
}
function progress(job:Record<string,unknown>):ImportProgress{return {id:String(job.id),total:Number(job.total),processed:Number(job.processed),imported:Number(job.imported),skipped:Number(job.skipped),nextChunk:Number(job.nextChunk),status:job.status as ImportProgress['status']};}
export async function startImport(user:User,id:string,filename:string,total:number){
  return transaction(async db=>{
    await run('INSERT IGNORE INTO import_jobs(id,actorId,filename,total) VALUES (?,?,?,?)',[id,user.id,filename,total],db);
    const [job]=await rows('SELECT * FROM import_jobs WHERE id=? FOR UPDATE',[id],db);
    if(job.actorId!==user.id)throw new HttpError(404,'Không tìm thấy phiên nhập dữ liệu của bạn.');
    if(job.total!==total||job.filename!==filename)throw new HttpError(409,'Phiên nhập không khớp dữ liệu. Hãy kiểm tra lại tệp.');
    return progress(job);
  });
}
export async function importChunk(user:User,id:string,index:number,records:ImportRecord[]){
  const digest=createHash('sha256').update(JSON.stringify(records)).digest('hex');
  return transaction(async db=>{
    const [job]=await rows('SELECT * FROM import_jobs WHERE id=? AND actorId=? FOR UPDATE',[id,user.id],db);
    if(!job)throw new HttpError(404,'Không tìm thấy phiên nhập dữ liệu của bạn.');
    const [previous]=await rows('SELECT digest FROM import_chunks WHERE jobId=? AND chunkIndex=?',[id,index],db);
    if(previous){if(previous.digest!==digest)throw new HttpError(409,'Dữ liệu của phần đã nhập bị thay đổi.');return progress(job);}
    if(job.status!=='running'||job.nextChunk!==index||job.processed+records.length>job.total)throw new HttpError(409,'Thứ tự hoặc số lượng dữ liệu nhập không hợp lệ.');
    const result=await writeRecords(user,records,db),processed=job.processed+records.length,imported=job.imported+result.imported,skipped=job.skipped+result.skipped,status=processed===job.total?'completed':'running';
    await run('INSERT INTO import_chunks(jobId,chunkIndex,digest) VALUES (?,?,?)',[id,index,digest],db);
    await run('UPDATE import_jobs SET processed=?,imported=?,skipped=?,nextChunk=nextChunk+1,status=? WHERE id=?',[processed,imported,skipped,status,id],db);
    if(status==='completed')await finishImport(user,id,job.filename,imported,skipped,db);
    return {id,total:job.total,processed,imported,skipped,nextChunk:index+1,status} as ImportProgress;
  });
}
export async function legacyImport(user:User,filename:string,records:ImportRecord[]){return transaction(async db=>{const result=await writeRecords(user,records,db);await finishImport(user,randomUUID(),filename,result.imported,result.skipped,db);return result;});}

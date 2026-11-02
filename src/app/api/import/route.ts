import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser,sameOrigin,HttpError} from '@/lib/auth';
import {importRowSchema} from '@/lib/schemas';
import {readImportFile} from '@/lib/import-file';
import {previewImport,startImport,importChunk,legacyImport} from '@/lib/import-service';
import {IMPORT_MAX_ROWS,IMPORT_MAX_BYTES,IMPORT_CHUNK_SIZE,mapImportRows,sheetImportData,suggestImportMapping} from '@/lib/import-data';
export const runtime='nodejs';
export const maxDuration=120;
const filename=z.string().trim().min(1).max(250);
const requestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('preview'),filename,records:z.array(z.object({row:z.number().int().min(1),data:z.record(z.string(),z.string().max(20000))})).min(1).max(IMPORT_MAX_ROWS)}),
  z.object({action:z.literal('start'),id:z.uuid(),filename,total:z.number().int().min(1).max(IMPORT_MAX_ROWS)}),
  z.object({action:z.literal('chunk'),id:z.uuid(),index:z.number().int().min(0).max(IMPORT_MAX_ROWS),records:z.array(importRowSchema).min(1).max(IMPORT_CHUNK_SIZE)}),
]);
export async function POST(request:Request){try{
  sameOrigin(request);const user=await requireUser();
  if((request.headers.get('content-type')||'').includes('multipart/form-data')){
    if(Number(request.headers.get('content-length')||0)>IMPORT_MAX_BYTES+200000)throw new HttpError(413,'Tệp tối đa 20 MB.');
    const form=await request.formData(),file=form.get('file');
    if(!(file instanceof File))throw new HttpError(400,'Chọn tệp CSV hoặc XLSX.');
    if(file.name.length>250)throw new HttpError(400,'Tên tệp tối đa 250 ký tự.');
    if(file.size>IMPORT_MAX_BYTES)throw new HttpError(413,'Tệp tối đa 20 MB.');
    let sheets;
    try{sheets=await readImportFile(file);}catch(error){
      const message=error instanceof Error&&['Chọn tệp','CSV sai','Chỉ hỗ trợ','Tệp','Mỗi sheet','Nội dung tệp'].some(prefix=>error.message.startsWith(prefix))?error.message:'Không đọc được tệp. Kiểm tra định dạng CSV hoặc XLSX.';
      throw new HttpError(400,message);
    }
    if(form.get('inspect')==='true')return NextResponse.json({filename:file.name,sheets},{headers:{'Cache-Control':'no-store'}});
    const sheet=sheets[0],mapping=suggestImportMapping(sheetImportData(sheet,1).headers);
    return NextResponse.json(await previewImport(user,file.name,mapImportRows(sheet,1,mapping,String(form.get('source')||''))));
  }
  if(Number(request.headers.get('content-length')||0)>50_000_000)throw new HttpError(413,'Dữ liệu đã chọn vượt 50 MB. Hãy chia tệp nhỏ hơn.');
  const raw=await request.text();if(Buffer.byteLength(raw)>50_000_000)throw new HttpError(413,'Dữ liệu đã chọn vượt 50 MB.');
  const body=JSON.parse(raw);
  if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'Dữ liệu gửi lên chưa đúng định dạng.');
  if(!body.action){const data=z.object({filename,records:z.array(importRowSchema).min(1).max(IMPORT_MAX_ROWS)}).parse(body);return NextResponse.json(await legacyImport(user,data.filename,data.records));}
  const data=requestSchema.parse(body);let result;
  if(data.action==='preview')result=await previewImport(user,data.filename,data.records);
  else if(data.action==='start')result=await startImport(user,data.id,data.filename,data.total);
  else result=await importChunk(user,data.id,data.index,data.records);
  return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
}catch(error){
  const status=error instanceof HttpError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500;
  const message=error instanceof HttpError?error.message:error instanceof z.ZodError?'Dữ liệu nhập chưa hợp lệ. Kiểm tra số dòng, trường bắt buộc và định dạng.':error instanceof SyntaxError?'Dữ liệu gửi lên chưa đúng định dạng.':error instanceof Error&&['Chọn tệp','CSV sai','Chỉ hỗ trợ','Tệp','Mỗi sheet','Nội dung tệp'].some(prefix=>error.message.startsWith(prefix))?error.message:'Không xử lý được dữ liệu nhập. Vui lòng kiểm tra tệp hoặc thử lại.';
  return NextResponse.json({error:message},{status,headers:{'Cache-Control':'no-store'}});
}}

import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireUser,ownAccount,sameOrigin,HttpError,type User} from '@/lib/auth';
import {rows,run,transaction} from '@/lib/db';
import {audit,notify} from '@/lib/activity';
export const runtime='nodejs';
async function access(user:User,parentType:string,parentId:string){
  if(!['product','rfq'].includes(parentType)||!z.uuid().safeParse(parentId).success)throw new HttpError(400,'Đối tượng không hợp lệ.');
  const [parent]=await rows(parentType==='product'?'SELECT id FROM products WHERE id=?':'SELECT accountId FROM rfqs WHERE id=?',[parentId]);
  if(!parent)throw new HttpError(404,'Không tìm thấy đối tượng.');if(parentType==='rfq')await ownAccount(user,parent.accountId);
}
async function handle(request:Request){try{
  const user=await requireUser(),url=new URL(request.url),id=url.searchParams.get('id');
  if(id&&['PATCH','DELETE'].includes(request.method)){
    sameOrigin(request);
    const filename=request.method==='PATCH'?z.object({filename:z.string().trim().min(1).max(200).regex(/^[^\r\n\\/]+\.pdf$/i,'Tên tài liệu phải kết thúc bằng .pdf và không chứa đường dẫn.')}).parse(await request.json()).filename:null;
    await transaction(async db=>{
      const [file]=await rows('SELECT id,parentType,parentId,filename FROM private_files WHERE id=? FOR UPDATE',[id],db);
      if(!file)throw new HttpError(404,'Không có tài liệu.');await access(user,file.parentType,file.parentId);
      if(request.method==='DELETE')await run('DELETE FROM private_files WHERE id=?',[id],db);
      else await run('UPDATE private_files SET filename=? WHERE id=?',[filename,id],db);
      await audit(user.id,request.method==='DELETE'?'private_document_deleted':'private_document_renamed',file.parentType,file.parentId,{fileId:id,filename:file.filename,newFilename:filename},db);
      await notify(user.id,'Đã cập nhật tài liệu',file.filename,'info',db);
    });return Response.json({ok:true});
  }
  if(request.method==='GET'&&id){
    const [file]=await rows('SELECT * FROM private_files WHERE id=?',[id]);if(!file)throw new HttpError(404,'Không có tài liệu.');await access(user,file.parentType,file.parentId);
    return new Response(new Uint8Array(file.content),{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}});
  }
  const parentType=url.searchParams.get('type')||'',parentId=url.searchParams.get('parentId')||'';await access(user,parentType,parentId);
  if(request.method==='GET')return Response.json(await rows('SELECT id,filename,size,createdAt FROM private_files WHERE parentType=? AND parentId=? ORDER BY createdAt DESC',[parentType,parentId]),{headers:{'Cache-Control':'no-store'}});
  sameOrigin(request);if(Number(request.headers.get('content-length')||0)>5_300_000)throw new HttpError(413,'Tài liệu tối đa 5 MB.');
  const form=await request.formData(),file=form.get('file');if(!(file instanceof File)||file.size>5_000_000||!file.size)throw new HttpError(400,'Chọn PDF tối đa 5 MB.');
  const content=Buffer.from(await file.arrayBuffer());if(!file.name.toLowerCase().endsWith('.pdf')||content.subarray(0,5).toString()!=='%PDF-')throw new HttpError(400,'Chỉ nhận tài liệu PDF.');
  const fileId=randomUUID(),filename=file.name.replace(/[\r\n\\/]/g,'_').slice(-200);await run('INSERT INTO private_files(id,parentType,parentId,filename,content,size,actorId) VALUES (?,?,?,?,?,?,?)',[fileId,parentType,parentId,filename,content,file.size,user.id]);await audit(user.id,'private_document_uploaded',parentType,parentId,{fileId,filename});return Response.json({id:fileId});
}catch(error){return Response.json({error:error instanceof HttpError?error.message:error instanceof z.ZodError?error.issues.map(issue=>issue.message).join(' '):'Không xử lý được tài liệu.'},{status:error instanceof HttpError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500});}}
export {handle as GET,handle as POST,handle as PATCH,handle as DELETE};

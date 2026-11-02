import nextEnv from '@next/env';
const production=process.argv.includes('--production');
if(production)Object.assign(process.env,{NODE_ENV:'production'});
nextEnv.loadEnvConfig(process.cwd(),!production);
const [{default:next},{createServer},{Server},{rows},{userFromToken,COOKIE}]=await Promise.all([import('next'),import('node:http'),import('socket.io'),import('./src/lib/db'),import('./src/lib/session')]);
const port=Number(process.env.PORT||3000),app=next({dev:!production});
await app.prepare();
const handler=app.getRequestHandler();
const server=createServer((request,response)=>{handler(request,response).catch(()=>{response.statusCode=500;response.end('Server error');});});
const origin=new URL(process.env.APP_URL||`http://localhost:${port}`).origin;
const io=new Server(server,{cors:{origin,credentials:true},allowRequest:(request,callback)=>callback(null,request.headers.origin===origin),maxHttpBufferSize:10000});
io.use(async(socket,done)=>{try{const cookie=socket.handshake.headers.cookie||'';const token=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);const user=await userFromToken(token);if(!user)return done(new Error('Unauthorized'));socket.data.user=user;socket.data.token=token;done();}catch{done(new Error('Database unavailable'));}});
io.on('connection',socket=>{socket.join('user:'+socket.data.user.id);socket.join('workspace');socket.emit('ready',{userId:socket.data.user.id});});
let cursor=Number((await rows('SELECT COALESCE(MAX(id),0) id FROM notifications'))[0].id),busy=false,ticks=0;
const timer=setInterval(async()=>{if(busy)return;busy=true;try{
  const events=await rows('SELECT * FROM notifications WHERE id>? ORDER BY id LIMIT 100',[cursor]);
  for(const event of events){io.to(event.userId?'user:'+event.userId:'workspace').emit('workspace:changed',{id:event.id,title:event.title,kind:event.kind});cursor=Number(event.id);}
  if(++ticks%30===0)for(const socket of io.sockets.sockets.values()){const user=await userFromToken(socket.data.token);if(!user)socket.disconnect(true);}
}catch{console.error('Realtime database poll failed');}finally{busy=false;}},1000);
const {runDirectQueue}=await import('./src/lib/direct-mail');
let directBusy=false;
const directTimer=setInterval(()=>{if(directBusy)return;directBusy=true;runDirectQueue().catch(()=>console.error('Direct mail worker failed')).finally(()=>{directBusy=false;});},1000);
server.listen(port,'0.0.0.0',()=>console.log(`Mailtemp chạy tại ${origin} · Socket.IO cùng cổng · SMTP ${process.env.MAIL_ENABLED==='true'?'đã bật':'đang tắt'}`));
const shutdown=()=>{clearInterval(timer);clearInterval(directTimer);io.close(()=>process.exit(0));};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);

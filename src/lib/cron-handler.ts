import {secretMatches} from './auth';

const headers={'Cache-Control':'private, no-store, max-age=0'};

export function createCronHandler(work:()=>Promise<unknown>,secret:()=>string|undefined=()=>process.env.CRON_SECRET){
  return async(request:Request):Promise<Response>=>{
    if(!['GET','POST'].includes(request.method))return Response.json({error:'Method not allowed'},{status:405,headers:{...headers,Allow:'GET, POST'}});
    const token=request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]||'';
    if(!secretMatches(token,secret()))return Response.json({error:'Unauthorized'},{status:401,headers});
    try{return Response.json(await work(),{headers});}
    catch(error){
      const code=(error as {code?:unknown})?.code;
      console.error('Cron execution failed',typeof code==='string'&&/^[A-Z0-9_]{1,50}$/.test(code)?code:'INTERNAL_ERROR');
      return Response.json({error:'Cron failed'},{status:500,headers});
    }
  };
}

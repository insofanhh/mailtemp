import {currentUser} from '@/lib/auth';
import {workspace} from '@/lib/workspace';
import {WorkspaceApp} from '@/components/workspace';
import {Login} from '@/components/login';
import Link from 'next/link';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{view?:string}>}){
  const {view}=await searchParams;
  let state:unknown=null,failed=false;
  try{const user=await currentUser();if(user)state=await workspace(user);}
  catch{failed=true;}
  if(failed)return <main className="setup-error"><span className="brand-symbol">m</span><h1>Kết nối không gian làm việc</h1><p>Ứng dụng chưa kết nối được MySQL. Hãy kiểm tra DATABASE_URL và chạy <code>npm run db:setup</code>.</p><Link className="button primary" href="/">Thử lại</Link></main>;
  return state?<WorkspaceApp initial={state} initialView={view}/>:<Login/>;
}

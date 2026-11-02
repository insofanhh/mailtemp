import type {Metadata} from 'next';
import './globals.css';
import './assistant.css';
import './import.css';
import './crud.css';
export const metadata:Metadata={title:'Mailtemp · Kết nối đối tác du lịch',description:'Không gian làm việc cho đội ngũ kinh doanh DMC: đại lý, chương trình, email và báo giá.'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="vi"><body>{children}</body></html>;}

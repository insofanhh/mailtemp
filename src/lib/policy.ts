export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export function todayVN(now = new Date()) { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
export function insideSendingWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Ho_Chi_Minh',hour:'numeric',hourCycle:'h23',weekday:'short'}).formatToParts(now);
  const day=parts.find(p=>p.type==='weekday')?.value;
  const hour=Number(parts.find(p=>p.type==='hour')?.value);
  return day!=='Sat' && day!=='Sun' && hour>=8 && hour<17;
}
export function interpolate(text: string, values: Record<string,string>) {
  return text.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g,(_,key:string)=> {
    const value=values[key]; if (!value?.trim()) throw new Error(`Thiếu biến {{${key}}}.`); return value;
  });
}
export type PolicyInput = {recipientPolicy?:string; hasProduct?:boolean; accountDeletedAt?:string|null; consentStatus:string; evidence?:string|null; purpose?:string|null; country:string; suppressed:boolean; validUntil:string; tier:string; productTier:string; source:string; lastReplyAt?:string|null; approvedAt?:string|null; lastContactedAt?:string|null; now?:Date};
export function blockReason(input: PolicyInput) {
  const now=input.now||new Date();
  if(input.accountDeletedAt)return 'Đại lý đã bị xóa.';
  if(input.suppressed||input.consentStatus==='suppressed') return 'Liên hệ nằm trong danh sách chặn.';
  if(input.consentStatus==='ineligible')return 'Liên hệ được đánh giá không đủ điều kiện nhận tin.';
  if(input.consentStatus==='needs_evidence')return 'Liên hệ cần bổ sung chứng cứ nhận tin.';
  if(!(input.recipientPolicy==='include_unreviewed'&&input.consentStatus==='unreviewed')&&(input.consentStatus!=='eligible'||!input.evidence?.trim()||!input.purpose?.trim())) return 'Chưa có đủ chứng cứ và mục đích nhận tin.';
  if(!input.source.trim()) return 'Thiếu nguồn dữ liệu.';
  if(input.country!=='VN') return 'Thị trường ngoài Việt Nam cần được cấu hình policy riêng.';
  if(input.hasProduct!==false){
    if(input.validUntil.slice(0,10)<todayVN(now)) return 'Bảng giá đã hết hiệu lực.';
    if(input.tier!==input.productTier) return 'Bảng giá không đúng nhóm đại lý.';
  }
  if(input.lastReplyAt && input.approvedAt && new Date(input.lastReplyAt+'Z')>=new Date(input.approvedAt+'Z')) return 'Khách đã phản hồi sau khi duyệt.';
  if(input.lastContactedAt && now.getTime()-new Date(input.lastContactedAt+'Z').getTime()<24*3600*1000) return 'Giới hạn nội bộ: cách lần gửi trước ít nhất 24 giờ.';
  return null;
}
export function escapeHtml(text:string) {return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}

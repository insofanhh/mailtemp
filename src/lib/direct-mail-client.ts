// A committed batch must remain visible even when a subsequent read fails.
export async function refreshDirectViews(tasks:Promise<unknown>[]){
  const results=await Promise.allSettled(tasks);
  return results.some(result=>result.status==='rejected')
    ?'Chưa tải được đầy đủ trạng thái mới nhất. Lượt gửi đã lưu vẫn được xử lý; hãy cập nhật kết quả.':'';
}
export const directPollDelay=(failures:number)=>Math.min(30_000,2_000*2**Math.min(4,failures));

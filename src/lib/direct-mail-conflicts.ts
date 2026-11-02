// Fixed aliases r/b are shared by direct and scheduled queries. A retry grant
// may be consumed only by a new direct send; scheduled sends still wait for it.
export const DIRECT_ACTIVE_SQL="(r.status='sending' OR (r.status='unknown' AND r.retryAuthorizedAt IS NULL) OR (r.status='pending' AND b.status IN ('queued','running','paused')))";
export const DIRECT_SCHEDULED_BLOCK_SQL="(r.status='sending' OR (r.status='unknown' AND r.retryConsumedBy IS NULL) OR (r.status='pending' AND b.status IN ('queued','running','paused')))";

export type MailConflict={kind:'direct'|'campaign';batchId:string|null;batchName:string;email:string;status:string;canManage:boolean};

import {runCron} from '@/lib/worker';
import {createCronHandler} from '@/lib/cron-handler';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
const handler=createCronHandler(runCron);
// Explicit HEAD prevents Next.js from using GET to execute a monitoring probe.
export {handler as GET,handler as POST,handler as HEAD};

import { processRoute } from '../../../../server/process-app';

export const runtime = 'nodejs';

export const GET = processRoute((routes) => routes.ops.alerts.GET);

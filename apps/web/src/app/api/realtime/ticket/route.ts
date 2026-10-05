import { processRoute } from '../../../../server/process-app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = processRoute((routes) => routes.ticket.POST);

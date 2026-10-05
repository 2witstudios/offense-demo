import { processRoute } from '../../../server/process-app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = processRoute((routes) => routes.confirm.GET);
export const HEAD = processRoute((routes) => routes.confirm.HEAD);
export const POST = processRoute((routes) => routes.confirm.POST);

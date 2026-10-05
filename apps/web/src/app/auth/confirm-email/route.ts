import { processRoute } from '../../../server/process-app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = processRoute((routes) => routes.confirmEmail.GET);
export const HEAD = processRoute((routes) => routes.confirmEmail.HEAD);
export const POST = processRoute((routes) => routes.confirmEmail.POST);

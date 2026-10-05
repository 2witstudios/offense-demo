import { processRoute } from '../../../../server/process-app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = processRoute((routes) => routes.auth.GET);
export const POST = processRoute((routes) => routes.auth.POST);
export const PATCH = processRoute((routes) => routes.auth.PATCH);
export const PUT = processRoute((routes) => routes.auth.PUT);
export const DELETE = processRoute((routes) => routes.auth.DELETE);

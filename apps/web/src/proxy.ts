import type { NextRequest } from 'next/server';
import { handleProxy } from './server/proxy-handler';
import { processApp } from './server/process-app';

export function proxy(request: NextRequest) {
  const app = processApp();
  return handleProxy(request, {
    publicAppUrl: app.config.PUBLIC_APP_URL,
    development: app.config.NODE_ENV === 'development',
    ids: app.ids,
  });
}
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

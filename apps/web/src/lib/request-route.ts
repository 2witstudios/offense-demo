import { headers } from 'next/headers';
import { inProcessFetch } from '../server/in-process-fetch';
import { processRoute } from '../server/process-app';
import type { Routes } from '../server/routes';

type Handler = (request: Request) => Promise<Response>;

/**
 * Headers that describe the browser's navigation to the page, not the
 * page's own read. A page reached from another site's link carries
 * `Sec-Fetch-Site: cross-site`, which a read route's same-origin gate
 * refuses; the read itself is made by this server, for the session that
 * navigated, and its answer only ever reaches that session's HTML.
 */
const navigationHeaders = [
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
];

type ReadRouteSeams = {
  /** Binds the picked handler; `processRoute` in production. */
  readonly bind?: (pick: (routes: Routes) => Handler) => Handler;
  /** This request's headers; Next's `headers()` in production. */
  readonly incoming?: () => Promise<Awaited<ReturnType<typeof headers>>>;
};

/**
 * The sanctioned way a server component reads data: it calls the bound
 * API route's GET handler in process with this request's own headers (its
 * session cookie, request id and the ingress's client identity), so the
 * route's session, rate-limit and `authorizeRequest` gates run exactly as
 * they do for the browser. A page never queries the database or decides
 * access itself. Writes stay server actions (`inProcessFetch` from an
 * `actions.ts`); this is GET only.
 */
export async function readRoute(
  pick: (routes: Routes) => Handler,
  path: string,
  { bind = processRoute, incoming = headers }: ReadRouteSeams = {},
): Promise<Response> {
  const forwarded = new Headers(await incoming());
  for (const name of navigationHeaders) forwarded.delete(name);
  return inProcessFetch(bind(pick), forwarded)(path, { method: 'GET' });
}

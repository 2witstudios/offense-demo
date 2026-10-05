import { fetchAlertConditions } from './auth-alert-probe';

/**
 * `/api/ops/alerts` answering 200 with this body, from a server bound to
 * 127.0.0.1 (ISSUE-252: a wildcard bind can share its port with another
 * process's loopback listener, which would answer instead).
 */
export async function alertsFrom(body: unknown) {
  using server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json(body),
  });
  // Awaited here: `using` stops the server as this function returns.
  return await fetchAlertConditions(`http://127.0.0.1:${server.port}`, 'token');
}

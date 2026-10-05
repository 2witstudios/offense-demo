import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Routes } from '../server/routes';
import { readRoute } from './request-route';

setupRitewayBun();

describe('readRoute', () => {
  test('calls the picked route in process with the page request’s session', async () => {
    const seen: Request[] = [];
    const picked: string[] = [];
    const sessionsGet = async (request: Request) => {
      seen.push(request);
      return Response.json({ sessions: [] });
    };
    const routes = { sessions: { GET: sessionsGet } } as unknown as Routes;
    const response = await readRoute(
      (table) => table.sessions.GET,
      '/api/account/sessions',
      {
        bind: (pick) => {
          picked.push(pick(routes) === sessionsGet ? 'sessions.GET' : 'other');
          return pick(routes);
        },
        incoming: async () =>
          new Headers({
            cookie: '__Secure-offense-demo.session_token=abc',
            'x-request-id': 'req_page',
            'x-offense-demo-client-ip': '203.0.113.9',
            origin: 'https://elsewhere.example',
            referer: 'https://elsewhere.example/post',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            'sec-fetch-user': '?1',
          }),
      },
    );
    const request = seen[0];
    assert({
      given: 'a page reached by a cross-site navigation reading its sessions',
      should:
        'GET the bound route with the session cookie, request id and client identity, and none of the navigation headers',
      actual: {
        picked,
        status: response.status,
        body: await response.json(),
        method: request?.method,
        path: request === undefined ? undefined : new URL(request.url).pathname,
        headers: Object.fromEntries(request?.headers ?? []),
      },
      expected: {
        picked: ['sessions.GET'],
        status: 200,
        body: { sessions: [] },
        method: 'GET',
        path: '/api/account/sessions',
        headers: {
          cookie: '__Secure-offense-demo.session_token=abc',
          'x-request-id': 'req_page',
          'x-offense-demo-client-ip': '203.0.113.9',
        },
      },
    });
  });
});

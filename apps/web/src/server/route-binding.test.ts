import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createRouteBinder } from './route-binding';

setupRitewayBun();

type Routes = { readonly ping: (request: Request) => Promise<Response> };

describe('createRouteBinder', () => {
  test('resolves the route table on the first request, not at binding', async () => {
    let resolved = 0;
    const bind = createRouteBinder<Routes>(() => {
      resolved += 1;
      return { ping: async () => new Response('pong') };
    });
    const handler = bind((routes) => routes.ping);
    const beforeRequest = resolved;
    const body = await (
      await handler(new Request('http://localhost/ping'))
    ).text();
    assert({
      given: 'a bound route that has not been called yet',
      should: 'build nothing until a request arrives, then delegate to it',
      actual: { beforeRequest, body },
      expected: { beforeRequest: 0, body: 'pong' },
    });
  });

  test('maps a route table that cannot be built through the public error contract', async () => {
    const handler = createRouteBinder<Routes>(() => {
      throw new Error('Invalid server configuration: DATABASE_URL');
    })((routes) => routes.ping);
    const response = await handler(new Request('http://localhost/ping'));
    const text = await response.text();
    assert({
      given: 'an app whose configuration fails validation',
      should:
        'answer 500 INTERNAL with a correlation id and no-store, never the cause',
      actual: {
        status: response.status,
        code: (JSON.parse(text) as { error: { code: string } }).error.code,
        requestId: Boolean(response.headers.get('x-request-id')),
        cacheControl: response.headers.get('cache-control'),
        leaks: text.includes('DATABASE_URL'),
      },
      expected: {
        status: 500,
        code: 'INTERNAL',
        requestId: true,
        cacheControl: 'no-store',
        leaks: false,
      },
    });
  });
});

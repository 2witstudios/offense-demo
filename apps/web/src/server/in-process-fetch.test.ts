import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { inProcessFetch } from './in-process-fetch';

setupRitewayBun();

describe('inProcessFetch', () => {
  test('hands the route the call with the browser request credentials', async () => {
    const seen: Request[] = [];
    const incoming = new Headers({
      origin: 'https://offense-demo.test',
      cookie: '__Secure-offense-demo.session_token=abc',
      'x-offense-demo-client-ip': '203.0.113.9',
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': '120',
    });
    const send = inProcessFetch(async (request) => {
      seen.push(request);
      return new Response(null, { status: 201 });
    }, incoming);
    const response = await send('/api/account/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"Ada"}',
    });
    const request = seen[0];
    assert({
      given: 'a call made while serving a browser form post',
      should:
        "call the handler with the browser's Origin, cookie and client identity, and the call's own body",
      actual: {
        status: response.status,
        method: request?.method,
        path: request === undefined ? undefined : new URL(request.url).pathname,
        origin: request?.headers.get('origin'),
        cookie: request?.headers.get('cookie'),
        client: request?.headers.get('x-offense-demo-client-ip'),
        type: request?.headers.get('content-type'),
        length: request?.headers.get('content-length'),
        body: await request?.text(),
      },
      expected: {
        status: 201,
        method: 'POST',
        path: '/api/account/username',
        origin: 'https://offense-demo.test',
        cookie: '__Secure-offense-demo.session_token=abc',
        client: '203.0.113.9',
        type: 'application/json',
        length: null,
        body: '{"username":"Ada"}',
      },
    });
  });
});

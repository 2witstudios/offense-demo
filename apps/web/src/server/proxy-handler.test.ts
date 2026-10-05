import { spyOn } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sequentialId } from '@offense-demo/clock';
import { handleProxy, type ProxySettings } from './proxy-handler';

setupRitewayBun();

const settings: ProxySettings = {
  publicAppUrl: 'https://offense-demo.invalid',
  development: false,
  ids: sequentialId('request'),
};
const proxy = (request: NextRequest, overrides: Partial<ProxySettings> = {}) =>
  handleProxy(request, { ...settings, ...overrides });

const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('proxy trace context propagation', () => {
  test('forwards a valid traceparent to the application request', () => {
    const response = proxy(
      new NextRequest('https://offense-demo.invalid/', {
        headers: { traceparent },
      }),
    );

    assert({
      given: 'a valid traceparent from ingress',
      should: 'forward it to the application request unchanged',
      actual: response.headers.get('x-middleware-request-traceparent'),
      expected: traceparent,
    });
  });

  test('does not forward a malformed traceparent', () => {
    const response = proxy(
      new NextRequest('https://offense-demo.invalid/', {
        headers: { traceparent: 'malformed' },
      }),
    );

    assert({
      given: 'a malformed traceparent from an untrusted request',
      should: 'remove it before the application request',
      actual: response.headers.get('x-middleware-request-traceparent'),
      expected: null,
    });
  });
});

const directives = (env: 'production' | 'development') => {
  const policy =
    proxy(new NextRequest('https://offense-demo.invalid/'), {
      development: env === 'development',
    }).headers.get('Content-Security-Policy') ?? '';
  return new Map(
    policy.split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ');
      return [name, sources] as const;
    }),
  );
};

describe('proxy content security policy', () => {
  test('draws the nonce from 16 CSPRNG bytes, never a repeatable value', () => {
    const nonceOf = (sources: readonly string[]) =>
      sources
        .find((source) => source.startsWith("'nonce-"))
        ?.slice("'nonce-".length, -1);
    const nonces = Array.from({ length: 20 }, () => {
      const sources = directives('production').get('script-src') ?? [];
      return nonceOf(sources) ?? '';
    });
    assert({
      given: '20 requests handled in a row',
      should: 'decode every nonce to exactly 16 bytes, all distinct',
      actual: {
        allSixteenBytes: nonces.every(
          (nonce) => Buffer.from(nonce, 'base64').length === 16,
        ),
        allDistinct: new Set(nonces).size === nonces.length,
      },
      expected: { allSixteenBytes: true, allDistinct: true },
    });
  });

  test('the nonce is the bytes the OS CSPRNG returned, and nothing else', () => {
    const drawn: number[] = [];
    const csprng = spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        drawn.push(bytes.length);
        bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
        return array;
      },
    );
    let nonce: string | undefined;
    try {
      nonce = (directives('production').get('script-src') ?? [])
        .find((source) => source.startsWith("'nonce-"))
        ?.slice("'nonce-".length, -1);
    } finally {
      csprng.mockRestore();
    }
    assert({
      given:
        'crypto.getRandomValues replaced by a spy returning the bytes 0..15',
      should:
        'draw 16 bytes from it once and encode exactly those bytes as the nonce',
      actual: { drawn, nonce },
      expected: {
        drawn: [16],
        nonce: Buffer.from(
          Array.from({ length: 16 }, (_, index) => index),
        ).toString('base64'),
      },
    });
  });

  test('keeps production style elements nonce-only', () => {
    const sources = directives('production').get('style-src') ?? [];
    assert({
      given: 'a production request',
      should: 'authorize style elements by nonce without unsafe-inline',
      actual: {
        self: sources.includes("'self'"),
        nonce: sources.some((source) => source.startsWith("'nonce-")),
        unsafeInline: sources.includes("'unsafe-inline'"),
      },
      expected: { self: true, nonce: true, unsafeInline: false },
    });
  });

  test('authorizes only the exact next/image style attributes by hash', () => {
    const hash = (style: string) =>
      `'sha256-${createHash('sha256').update(style).digest('base64')}'`;
    assert({
      given: 'a production request',
      should:
        'allow the fill and default next/image style attributes and nothing else',
      actual: directives('production').get('style-src-attr'),
      expected: [
        "'unsafe-hashes'",
        hash(
          'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent',
        ),
        hash('color:transparent'),
      ],
    });
  });

  test('leaves development on the permissive style policy', () => {
    assert({
      given: 'a development request',
      should: 'not emit a separate style attribute directive',
      actual: directives('development').has('style-src-attr'),
      expected: false,
    });
  });
});

describe('proxy early sign-in hint', () => {
  const at = (path: string, cookie?: string) =>
    proxy(
      new NextRequest(`https://internal.invalid${path}`, {
        headers: cookie ? { cookie } : {},
      }),
    );

  test('sends a cookie-less request for a guarded area to sign-in with its path', () => {
    const response = at('/app/tables?tab=open');
    assert({
      given: 'a request for a guarded descendant with no session cookie',
      should:
        'redirect to sign-in on the public origin carrying the local path and query',
      actual: [response.status, response.headers.get('location')],
      expected: [
        307,
        'https://offense-demo.invalid/sign-in?next=%2Fapp%2Ftables%3Ftab%3Dopen',
      ],
    });
  });

  test('the redirect keeps the CSP and correlation contracts', () => {
    const response = at('/settings');
    assert({
      given: 'a redirected guarded request',
      should: 'carry a CSP, a request id and no-store',
      actual: [
        response.headers
          .get('content-security-policy')
          ?.startsWith("default-src 'self'"),
        Boolean(response.headers.get('x-request-id')),
        response.headers.get('cache-control'),
      ],
      expected: [true, true, 'no-store'],
    });
  });

  test('lets a request with a session cookie through to the per-page check', () => {
    assert({
      given: 'guarded requests carrying either session cookie name',
      should: 'continue to the page, which rechecks the durable session',
      actual: [
        at('/play', 'better-auth.session_token=x').status,
        at('/play', '__Secure-better-auth.session_token=x').status,
      ],
      expected: [200, 200],
    });
  });

  test('leaves spectator and public routes open', () => {
    assert({
      given: 'cookie-less requests for public routes and lookalikes',
      should: 'not redirect',
      actual: ['/', '/watch', '/watch/abc', '/sign-in', '/playground'].map(
        (path) => at(path).status,
      ),
      expected: [200, 200, 200, 200, 200],
    });
  });
});

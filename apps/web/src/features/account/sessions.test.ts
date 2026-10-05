import { APIError } from 'better-auth/api';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { silentLogger } from '../../server/test-loggers.test-support';
import {
  createListSessionsHandler,
  createRevokeSessionHandler,
} from './sessions';

setupRitewayBun();

const origin = 'http://localhost:3000';
const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 's1',
  token: 'super-secret-bearer-token',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-08T00:00:00.000Z',
  userAgent: 'Firefox',
  ipAddress: '203.0.113.9',
  ...overrides,
});

const get = () => new Request(`${origin}/api/account/sessions`);
const post = (body: unknown) =>
  new Request(`${origin}/api/account/sessions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });

describe('GET /api/account/sessions', () => {
  test('never serializes the session token, and marks the current row', async () => {
    const rows = [row({ id: 's1' }), row({ id: 's2', token: 'other-token' })];
    const handler = createListSessionsHandler({
      logger: silentLogger,
      origin: () => origin,
      listSessions: async () => rows,
      currentSessionId: async () => 's2',
    });
    const response = await handler(get());
    const body = await response.text();
    const parsed = JSON.parse(body) as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    assert({
      given: "two real session rows, one of them the caller's own",
      should:
        'answer 200 with no token or client IP anywhere in the body and the right row flagged current',
      actual: {
        status: response.status,
        leaksToken:
          body.includes('super-secret-bearer-token') ||
          body.includes('other-token'),
        leaksIp: body.includes('203.0.113.9'),
        fields: Object.keys(parsed.sessions[0] ?? {}).sort(),
        currentFlags: parsed.sessions.map((s) => [s.id, s.current]),
      },
      expected: {
        status: 200,
        leaksToken: false,
        leaksIp: false,
        fields: [
          'createdAt',
          'current',
          'expiresAt',
          'id',
          'updatedAt',
          'userAgent',
        ],
        currentFlags: [
          ['s1', false],
          ['s2', true],
        ],
      },
    });
  });

  test('a stale/unauthenticated session answers 401, never leaking Better Auth detail', async () => {
    const handler = createListSessionsHandler({
      logger: silentLogger,
      origin: () => origin,
      listSessions: async () => {
        throw new APIError('UNAUTHORIZED', { message: 'no session' });
      },
      currentSessionId: async () => null,
    });
    const response = await handler(get());
    const body = await response.text();
    assert({
      given: 'listSessions rejecting with an unauthenticated Better Auth error',
      should: 'answer 401 with no internal detail',
      actual: {
        status: response.status,
        leaks: body.includes('no session'),
      },
      expected: { status: 401, leaks: false },
    });
  });

  test('an infrastructure failure answers a safe 503', async () => {
    const handler = createListSessionsHandler({
      logger: silentLogger,
      origin: () => origin,
      listSessions: async () => {
        throw new Error('redis://secret-host down');
      },
      currentSessionId: async () => null,
    });
    const response = await handler(get());
    const body = await response.text();
    assert({
      given: 'listSessions rejecting with an unexpected infrastructure error',
      should: 'answer 503 with no internal detail',
      actual: { status: response.status, leaks: body.includes('secret-host') },
      expected: { status: 503, leaks: false },
    });
  });
});

describe('POST /api/account/sessions/revoke', () => {
  test('revokes by id, resolving the token server-side only', async () => {
    const rows = [row({ id: 's1', token: 'token-1' })];
    let revokedWith: { headers: Headers; token: string } | undefined;
    const handler = createRevokeSessionHandler({
      logger: silentLogger,
      origin: () => origin,
      listSessions: async () => rows,
      revokeToken: async (headers, token) => {
        revokedWith = { headers, token };
      },
    });
    const response = await handler(post({ id: 's1' }));
    assert({
      given: 'a session id owned by the caller',
      should: 'resolve it to the matching token and revoke, answering ok',
      actual: {
        status: response.status,
        body: await response.json(),
        revokedToken: revokedWith?.token,
      },
      expected: {
        status: 200,
        body: { status: true },
        revokedToken: 'token-1',
      },
    });
  });

  test("an id not among the caller's own sessions reports not-found, never revoking anything", async () => {
    let revoked = false;
    const handler = createRevokeSessionHandler({
      logger: silentLogger,
      origin: () => origin,
      listSessions: async () => [row({ id: 's1' })],
      revokeToken: async () => {
        revoked = true;
      },
    });
    const response = await handler(post({ id: 'not-mine' }));
    assert({
      given: "a session id that is not among the caller's own rows",
      should: 'answer 404 and revoke nothing',
      actual: { status: response.status, revoked },
      expected: { status: 404, revoked: false },
    });
  });

  test('refuses a cross-origin request before resolving anything', async () => {
    let listed = false;
    const handler = createRevokeSessionHandler({
      logger: silentLogger,
      origin: () => origin,
      listSessions: async () => {
        listed = true;
        return [];
      },
      revokeToken: async () => {},
    });
    const response = await handler(
      new Request(`${origin}/api/account/sessions/revoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ id: 's1' }),
      }),
    );
    assert({
      given: 'a cross-origin POST',
      should: 'answer 403 without listing sessions',
      actual: { status: response.status, listed },
      expected: { status: 403, listed: false },
    });
  });
});

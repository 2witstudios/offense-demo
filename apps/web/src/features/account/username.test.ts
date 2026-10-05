import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Identity } from '@offense-demo/auth';
import { silentLogger } from '../../server/test-loggers.test-support';
import { createUsernameHandler } from './username';

setupRitewayBun();

const member: Identity = {
  state: 'provisional',
  principal: { kind: 'user', userId: 'user1' },
};

const handlerWith = ({
  identity = member,
  consume = async () => ({ allowed: true, retryAfterSeconds: 0 }),
}: {
  identity?: Identity;
  consume?: () => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
} = {}) => {
  const claims: unknown[] = [];
  const handler = createUsernameHandler({
    logger: silentLogger,
    origin: () => 'http://localhost:3000',
    identify: async () => identity,
    limiter: () => ({ consume }),
    claim: async (input) => {
      claims.push(input);
      return { kind: 'claimed' };
    },
  });
  return { handler, claims };
};

const post = (body = { username: 'ada' }) =>
  new Request('http://localhost:3000/api/account/username', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
    },
    body: JSON.stringify(body),
  });

describe('POST /api/account/username gates', () => {
  test('a session-store outage is a retryable 503, not a sign-out', async () => {
    const { handler, claims } = handlerWith({
      identity: { state: 'unavailable', principal: { kind: 'anonymous' } },
    });
    const response = await handler(post());
    assert({
      given: 'an identity that could not be resolved',
      should: 'answer 503 INFRASTRUCTURE and claim nothing',
      actual: [
        response.status,
        ((await response.json()) as { error: { code: string } }).error.code,
        claims,
      ],
      expected: [503, 'INFRASTRUCTURE', []],
    });
  });

  test('a limiter outage fails closed with 503 before any durable work', async () => {
    const { handler, claims } = handlerWith({
      consume: async () => {
        throw new Error('redis down');
      },
    });
    assert({
      given: 'a limiter that throws',
      should: 'answer 503 and claim nothing',
      actual: [(await handler(post())).status, claims],
      expected: [503, []],
    });
  });

  test('a malformed limiter answer is an outage, not a rate limit', async () => {
    const { handler, claims } = handlerWith({
      consume: async () =>
        ({}) as { allowed: boolean; retryAfterSeconds: number },
    });
    assert({
      given: 'a limiter that answers without a boolean verdict',
      should: 'fail closed with 503 and claim nothing',
      actual: [(await handler(post())).status, claims],
      expected: [503, []],
    });
  });

  test('an anonymous caller is 401 and a limited one is 429', async () => {
    const anonymous = handlerWith({
      identity: { state: 'anonymous', principal: { kind: 'anonymous' } },
    });
    const limited = handlerWith({
      consume: async () => ({ allowed: false, retryAfterSeconds: 30 }),
    });
    assert({
      given: 'no session, and a session over its claim allowance',
      should: 'answer 401 and 429, claiming nothing',
      actual: [
        (await anonymous.handler(post())).status,
        (await limited.handler(post())).status,
        anonymous.claims.length + limited.claims.length,
      ],
      expected: [401, 429, 0],
    });
  });

  test('refuses Origin: null even with Sec-Fetch-Site: same-origin', async () => {
    const { handler, claims } = handlerWith();
    const response = await handler(
      new Request('http://localhost:3000/api/account/username', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ username: 'ada' }),
      }),
    );
    assert({
      given:
        'a claim posted with the opaque form origin carve-out headers, not a fetch from this origin',
      should: 'refuse with 403 AUTHORIZATION and claim nothing',
      actual: [
        response.status,
        ((await response.json()) as { error: { code: string } }).error.code,
        claims,
      ],
      expected: [403, 'AUTHORIZATION', []],
    });
  });

  test('a verified account claims the normalized name for its own id', async () => {
    const { handler, claims } = handlerWith();
    const response = await handler(post({ username: '  Ada_1 ' }));
    assert({
      given: 'a provisional account posting a padded, capitalized name',
      should: 'claim the lowercase name for the session user and answer 201',
      actual: [response.status, await response.json(), claims],
      expected: [
        201,
        { username: 'ada_1' },
        [{ userId: 'user1', username: 'ada_1' }],
      ],
    });
  });
});

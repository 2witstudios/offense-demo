import { createHash } from 'node:crypto';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Identity } from '@offense-demo/auth';
import { ticketSchema } from '@offense-demo/protocol';
import { silentLogger } from '../../server/test-loggers.test-support';
import { createTicketHandler } from './ticket';

setupRitewayBun();

const member: Identity = {
  state: 'member',
  username: 'ada',
  principal: {
    kind: 'user',
    userId: 'user1',
    permissions: ['app:read', 'app:write'],
  },
};

const handlerWith = ({
  identity = member,
  consume = async () => ({ allowed: true, retryAfterSeconds: 0 }),
  sessionId = async () => 'session1',
  issue = async () => {},
}: {
  identity?: Identity;
  consume?: (
    key: string,
    rule: unknown,
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  sessionId?: () => Promise<string | null>;
  issue?: (input: {
    readonly ticketHash: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly origin: string;
    readonly ttlSeconds: number;
  }) => Promise<void>;
} = {}) => {
  const consumeCalls: Array<{ key: string; rule: unknown }> = [];
  const issued: Array<{
    readonly ticketHash: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly origin: string;
    readonly ttlSeconds: number;
  }> = [];
  const handler = createTicketHandler({
    logger: silentLogger,
    origin: () => 'http://localhost:3000/',
    identify: async () => identity,
    sessionId,
    limiter: () => ({
      consume: async (key, rule) => {
        consumeCalls.push({ key, rule });
        return consume(key, rule);
      },
    }),
    issueTicket: async (input) => {
      issued.push(input);
      return issue(input);
    },
  });
  return { handler, consumeCalls, issued };
};

const post = (headers?: Record<string, string>) =>
  new Request('http://localhost:3000/api/realtime/ticket', {
    method: 'POST',
    headers: headers ?? { origin: 'http://localhost:3000' },
  });

/** A refused response's status alongside its public error code. */
const statusAndCode = async (response: Response): Promise<[number, string]> => [
  response.status,
  ((await response.json()) as { error: { code: string } }).error.code,
];

describe('POST /api/realtime/ticket gates', () => {
  test('a session-store outage is a retryable 503, not a sign-out', async () => {
    const { handler, issued } = handlerWith({
      identity: { state: 'unavailable', principal: { kind: 'anonymous' } },
    });
    const response = await handler(post());
    assert({
      given: 'an identity that could not be resolved',
      should: 'answer 503 INFRASTRUCTURE and issue nothing',
      actual: [...(await statusAndCode(response)), issued],
      expected: [503, 'INFRASTRUCTURE', []],
    });
  });

  test('a foreign Origin is refused before any session read, rate-limit spend or issue', async () => {
    const { handler, issued, consumeCalls } = handlerWith();
    const response = await handler(
      post({ origin: 'https://attacker.example' }),
    );
    assert({
      given: 'a request whose Origin does not match the app',
      should:
        'answer 403 AUTHORIZATION and touch neither the limiter nor issueTicket',
      actual: [...(await statusAndCode(response)), consumeCalls, issued],
      expected: [403, 'AUTHORIZATION', [], []],
    });
  });

  test('a missing Origin is refused before any session read, rate-limit spend or issue', async () => {
    const { handler, issued, consumeCalls } = handlerWith();
    const response = await handler(post({}));
    assert({
      given: 'a request with no Origin header at all',
      should:
        'answer 403 AUTHORIZATION and touch neither the limiter nor issueTicket',
      actual: [...(await statusAndCode(response)), consumeCalls, issued],
      expected: [403, 'AUTHORIZATION', [], []],
    });
  });

  test('an anonymous caller is 401', async () => {
    const { handler, issued } = handlerWith({
      identity: { state: 'anonymous', principal: { kind: 'anonymous' } },
    });
    const response = await handler(post());
    assert({
      given: 'no session',
      should: 'answer 401 AUTHENTICATION and issue nothing',
      actual: [...(await statusAndCode(response)), issued],
      expected: [401, 'AUTHENTICATION', []],
    });
  });

  test('a provisional (no-username) caller is 403', async () => {
    const { handler, issued } = handlerWith({
      identity: {
        state: 'provisional',
        principal: { kind: 'user', userId: 'user1', permissions: [] },
      },
    });
    const response = await handler(post());
    assert({
      given: 'a signed-in account that has not claimed a username',
      should: 'answer 403 AUTHORIZATION and issue nothing',
      actual: [...(await statusAndCode(response)), issued],
      expected: [403, 'AUTHORIZATION', []],
    });
  });

  test('a limiter outage fails closed with 503 before any durable work', async () => {
    const { handler, issued } = handlerWith({
      consume: async () => {
        throw new Error('redis down');
      },
    });
    assert({
      given: 'a limiter that throws',
      should: 'answer 503 and issue nothing',
      actual: [(await handler(post())).status, issued],
      expected: [503, []],
    });
  });

  test('a malformed limiter answer is an outage, not a rate limit', async () => {
    const { handler, issued } = handlerWith({
      consume: async () =>
        ({}) as { allowed: boolean; retryAfterSeconds: number },
    });
    assert({
      given: 'a limiter that answers without a boolean verdict',
      should: 'fail closed with 503 and issue nothing',
      actual: [(await handler(post())).status, issued],
      expected: [503, []],
    });
  });

  test('a caller over its allowance is 429', async () => {
    const { handler, issued } = handlerWith({
      consume: async () => ({ allowed: false, retryAfterSeconds: 30 }),
    });
    assert({
      given: 'a session over its ticket allowance',
      should: 'answer 429 and issue nothing',
      actual: [(await handler(post())).status, issued],
      expected: [429, []],
    });
  });

  test('the rate-limit bucket is keyed by the session user, not a body field', async () => {
    const { handler, consumeCalls } = handlerWith();
    await handler(post());
    assert({
      given: 'a signed-in member',
      should: "key the limiter bucket by the session's own userId",
      actual: consumeCalls[0]?.key,
      expected: 'realtime:ticket:user1',
    });
  });

  test('a session that lapsed between the two reads is 401, after the rate limit runs', async () => {
    const { handler, issued, consumeCalls } = handlerWith({
      sessionId: async () => null,
    });
    const response = await handler(post());
    assert({
      given:
        'an identity resolved as a member, but no live session id moments later',
      should:
        'answer 401 and issue nothing, having already spent the rate-limit budget',
      actual: [response.status, issued, consumeCalls.length],
      expected: [401, [], 1],
    });
  });
});

describe('POST /api/realtime/ticket, the happy path', () => {
  test('issues a ticket, hashes it, and binds it to the user, session and canonical origin', async () => {
    const { handler, issued } = handlerWith();
    const response = await handler(post());
    const body = (await response.json()) as {
      ticket: string;
      expiresInSeconds: number;
    };
    const expectedHash = createHash('sha3-256')
      .update(body.ticket)
      .digest('hex');
    assert({
      given: 'a signed-in member',
      should:
        '200 with a 43-char base64url ticket and a 60s TTL, bound by its hash to {userId, sessionId, origin}',
      actual: [
        response.status,
        ticketSchema.safeParse(body.ticket).success,
        body.expiresInSeconds,
        issued,
      ],
      expected: [
        200,
        true,
        60,
        [
          {
            ticketHash: expectedHash,
            userId: 'user1',
            sessionId: 'session1',
            origin: 'http://localhost:3000',
            ttlSeconds: 60,
          },
        ],
      ],
    });
  });

  test('two issuances mint two distinct CSPRNG tickets', async () => {
    const { handler } = handlerWith();
    const [first, second] = await Promise.all([
      handler(post()).then((r) => r.json() as Promise<{ ticket: string }>),
      handler(post()).then((r) => r.json() as Promise<{ ticket: string }>),
    ]);
    assert({
      given: 'two ticket issuances',
      should: 'mint two different tickets',
      actual: first.ticket === second.ticket,
      expected: false,
    });
  });
});

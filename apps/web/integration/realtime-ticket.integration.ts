import { createHash } from 'node:crypto';
import { openTestRedis } from '@offense-demo/redis/testing';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { ticketSchema } from '@offense-demo/protocol';
import { createAccountFlows, uniqueName } from './auth-account-helpers';
import { origin, testRedisUrl, withSql } from './fixtures';

requireTestServices(process.env);
setupRitewayBun();

const { flows, signUp, claim } = createAccountFlows();
const { testApp, jsonPost } = flows;
const ticketRoute = testApp.routes.ticket;

/** A real signed-in member (claimed username) through the mounted routes. */
async function memberSession() {
  const { email, cookie } = await signUp();
  const username = uniqueName();
  const claimed = await claim(cookie, { username });
  if (claimed.status !== 201)
    throw new Error(`fixture: claiming a username failed (${claimed.status})`);
  const [row] = (await withSql(
    (sql) => sql`
      SELECT u.id AS "userId", s.id AS "sessionId"
      FROM users u
      JOIN session s ON s.user_id = u.id
      WHERE u.email = ${email}
    `,
  )) as { userId: string; sessionId: string }[];
  if (!row) throw new Error('fixture: no user/session row for the new member');
  return { email, cookie, userId: row.userId, sessionId: row.sessionId };
}

const postTicket = (cookie: string, headers: Record<string, string> = {}) =>
  ticketRoute.POST(
    jsonPost('/api/realtime/ticket', {}, { cookie, ...headers }),
  );

/** Reads a Redis key's value and TTL through a fresh, short-lived client. */
async function readRedisKey(key: string) {
  const client = openTestRedis(testRedisUrl);
  try {
    const [value, ttlMs] = await Promise.all([
      client.get(key),
      client.send('PTTL', [key]).then(Number),
    ]);
    return { value, ttlMs };
  } finally {
    client.close();
  }
}

describe('RT-2.4a POST /api/realtime/ticket through the mounted route', () => {
  test('stores only the ticket hash in Redis, bound to the real user, session and origin, TTL <= 60s', async () => {
    const { cookie, userId, sessionId } = await memberSession();

    const response = await postTicket(cookie);
    const body = (await response.json()) as {
      ticket: string;
      expiresInSeconds: number;
    };
    const hash = createHash('sha3-256').update(body.ticket).digest('hex');
    const key = `${testApp.redisNamespace}:v1:ticket:${hash}`;
    const { value: raw, ttlMs } = await readRedisKey(key);
    const binding = raw ? (JSON.parse(raw) as unknown) : null;

    assert({
      given: "a real signed-in member's request over the mounted route",
      should:
        'answer 200 with a 43-char ticket and 60s TTL, and store in Redis only its hash, bound to exactly {userId, sessionId, origin}, with no plaintext ticket in the key or value',
      actual: {
        status: response.status,
        ticketShapeOk: ticketSchema.safeParse(body.ticket).success,
        expiresInSeconds: body.expiresInSeconds,
        binding,
        ttlWithinBudget: ttlMs > 0 && ttlMs <= 60_000,
        keyContainsPlaintext: key.includes(body.ticket),
        valueContainsPlaintext: raw?.includes(body.ticket) ?? false,
      },
      expected: {
        status: 200,
        ticketShapeOk: true,
        expiresInSeconds: 60,
        binding: { userId, sessionId, origin },
        ttlWithinBudget: true,
        keyContainsPlaintext: false,
        valueContainsPlaintext: false,
      },
    });
  });

  test('a foreign or missing Origin is refused, with no rate-limit spend and no ticket issued', async () => {
    const { cookie } = await memberSession();
    const ticketKeyCount = async () =>
      (await testApp.redisKeys()).filter(({ key }) =>
        key.includes(':v1:ticket:'),
      ).length;
    // Counted as a delta, not an absolute zero: the suite's own namespace
    // may already hold an unconsumed ticket from an earlier test in this
    // file, which this test must not treat as a failure of its own.
    const before = await ticketKeyCount();

    const foreign = await postTicket(cookie, {
      origin: 'https://attacker.example',
    });
    const foreignBody = (await foreign.json()) as { error: { code: string } };

    const missing = await ticketRoute.POST(
      new Request(`${testApp.origin}/api/realtime/ticket`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      }),
    );
    const missingBody = (await missing.json()) as { error: { code: string } };

    const after = await ticketKeyCount();

    assert({
      given:
        'a request whose Origin does not match the app, and one with no Origin at all',
      should:
        'answer 403 AUTHORIZATION for both, before any rate-limit consumption or ticket write',
      actual: {
        foreignStatus: foreign.status,
        foreignCode: foreignBody.error.code,
        missingStatus: missing.status,
        missingCode: missingBody.error.code,
        newTicketKeysIssued: after - before,
      },
      expected: {
        foreignStatus: 403,
        foreignCode: 'AUTHORIZATION',
        missingStatus: 403,
        missingCode: 'AUTHORIZATION',
        newTicketKeysIssued: 0,
      },
    });
  });
});

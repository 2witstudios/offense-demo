import { expect, test } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { createHash } from 'node:crypto';
import { requireTestServices } from '@offense-demo/config';
import { createRedis, redisKey } from '../src';
import { testNamespace } from '../src/testing';
import { rawClient } from './test-support';

const { redisUrl: url } = requireTestServices(process.env);

const sha3 = (value: string) =>
  createHash('sha3-256').update(value).digest('hex');

/** A fresh namespace, binding and ticket hash for one test's own ticket. */
function ticketFixture() {
  return {
    namespace: testNamespace(createId()),
    userId: createId(),
    sessionId: createId(),
    origin: 'https://offense-demo.example',
    ticketHash: sha3(createId()),
  };
}

async function issueFixtureTicket(
  redis: ReturnType<typeof createRedis>,
  fixture: ReturnType<typeof ticketFixture>,
  ttlSeconds = 60,
): Promise<void> {
  await redis.issueConnectTicket(
    fixture.ticketHash,
    {
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      origin: fixture.origin,
    },
    ttlSeconds,
  );
}

/** A fresh, already-issued ticket plus a raw client for direct key assertions. */
async function issuedFixtureWithRawAccess(): Promise<{
  readonly fixture: ReturnType<typeof ticketFixture>;
  readonly redis: ReturnType<typeof createRedis>;
  readonly raw: Awaited<ReturnType<typeof rawClient>>;
  readonly key: string;
}> {
  const fixture = ticketFixture();
  const redis = createRedis({ url, namespace: fixture.namespace });
  const raw = await rawClient(url);
  const key = redisKey(fixture.namespace, 'ticket', fixture.ticketHash);
  try {
    await issueFixtureTicket(redis, fixture);
  } catch (error) {
    redis.close();
    raw.close();
    throw error;
  }
  return { fixture, redis, raw, key };
}

test('a ticket is single-use: the second GETDEL finds nothing', async () => {
  const fixture = ticketFixture();
  const redis = createRedis({ url, namespace: fixture.namespace });
  try {
    await issueFixtureTicket(redis, fixture);

    const first = await redis.consumeConnectTicket(
      fixture.ticketHash,
      fixture.origin,
    );
    const replay = await redis.consumeConnectTicket(
      fixture.ticketHash,
      fixture.origin,
    );

    expect(first).toEqual({
      accepted: true,
      userId: fixture.userId,
      sessionId: fixture.sessionId,
    });
    // A negative control: a ticket consumed once must not be consumable
    // again, proving GETDEL actually removed it rather than merely reading it.
    expect(replay).toEqual({ accepted: false, reason: 'not-found' });
  } finally {
    redis.close();
  }
});

test('a ticket bound to a different origin is rejected, and still consumed', async () => {
  const fixture = ticketFixture();
  const redis = createRedis({ url, namespace: fixture.namespace });
  try {
    await issueFixtureTicket(redis, fixture);

    const mismatched = await redis.consumeConnectTicket(
      fixture.ticketHash,
      'https://attacker.example',
    );
    const replay = await redis.consumeConnectTicket(
      fixture.ticketHash,
      fixture.origin,
    );

    expect(mismatched).toEqual({ accepted: false, reason: 'origin-mismatch' });
    // Negative control: even a rejected (wrong-origin) consumption is single-use.
    expect(replay).toEqual({ accepted: false, reason: 'not-found' });
  } finally {
    redis.close();
  }
});

test('an expired ticket is rejected as not-found', async () => {
  const { fixture, redis, raw, key } = await issuedFixtureWithRawAccess();
  try {
    // Forces the stored ticket to have already expired, rather than
    // sleeping past its real TTL (flaky, and needlessly slow).
    await raw.send('PEXPIRE', [key, '-1']);

    expect(
      await redis.consumeConnectTicket(fixture.ticketHash, fixture.origin),
    ).toEqual({
      accepted: false,
      reason: 'not-found',
    });
  } finally {
    redis.close();
    raw.close();
  }
});

test('an unknown ticket hash is rejected as not-found', async () => {
  const fixture = ticketFixture();
  const redis = createRedis({ url, namespace: fixture.namespace });
  try {
    expect(
      await redis.consumeConnectTicket(sha3(createId()), 'https://x.example'),
    ).toEqual({ accepted: false, reason: 'not-found' });
  } finally {
    redis.close();
  }
});

test('25 concurrent consumers on separate connections accept the ticket exactly once', async () => {
  const fixture = ticketFixture();
  const issuer = createRedis({ url, namespace: fixture.namespace });
  // Each consumer dials its own connection: a shared client would already
  // serialize commands and hide a non-atomic implementation (get-then-del)
  // behind Bun's own connection queue, so this would not actually exercise
  // Redis's cross-connection atomicity.
  const consumers = Array.from({ length: 25 }, () =>
    createRedis({ url, namespace: fixture.namespace }),
  );
  try {
    await issueFixtureTicket(issuer, fixture);

    const results = await Promise.all(
      consumers.map((consumer) =>
        consumer.consumeConnectTicket(fixture.ticketHash, fixture.origin),
      ),
    );

    const accepted = results.filter((result) => result.accepted);
    // Negative control (mirrors the reviewer's mutation): replacing GETDEL
    // with GET then DEL turns this from exactly 1 into as many as 25, since
    // every connection can read the value before any of them deletes it.
    expect(accepted.length).toBe(1);
    expect(accepted[0]).toEqual({
      accepted: true,
      userId: fixture.userId,
      sessionId: fixture.sessionId,
    });
    expect(
      results.filter((result) => !result.accepted).map((result) => result),
    ).toEqual(Array(24).fill({ accepted: false, reason: 'not-found' }));
  } finally {
    issuer.close();
    for (const consumer of consumers) consumer.close();
  }
});

test('the ticket key carries a mandatory TTL, never a bare SET', async () => {
  const { fixture, redis, raw, key } = await issuedFixtureWithRawAccess();
  try {
    const ttl = await raw.send('TTL', [key]);
    expect(Number(ttl)).toBeGreaterThan(0);
    expect(Number(ttl)).toBeLessThanOrEqual(60);
  } finally {
    await redis.consumeConnectTicket(fixture.ticketHash, fixture.origin);
    redis.close();
    raw.close();
  }
});

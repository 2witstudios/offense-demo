import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createOfflineRedis, createTestRedis } from './test-support';

setupRitewayBun();

const userId = 'a'.repeat(24);
const sessionId = 'b'.repeat(24);
const origin = 'https://offense-demo.example';
const ticketHash = 'f'.repeat(64);
const binding = { userId, sessionId, origin };

describe('issueConnectTicket', () => {
  test('stores only the hash, bound to user, session and origin, with an expiry', async () => {
    const { redis, commands } = createTestRedis();

    await redis.issueConnectTicket(ticketHash, binding, 60);

    assert({
      given: 'a valid ticket hash and binding',
      should: 'SET the namespaced ticket key with an EX expiry',
      actual: commands.find(({ command }) => command === 'SET'),
      expected: {
        command: 'SET',
        args: [
          `test:v1:ticket:${ticketHash}`,
          JSON.stringify(binding),
          'EX',
          '60',
        ],
      },
    });
  });

  test('refuses an invalid hash, binding or TTL before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(
      redis.issueConnectTicket('not-a-hash', binding, 60),
    ).rejects.toThrow('Invalid ticket hash');
    await expect(
      redis.issueConnectTicket(ticketHash, { ...binding, userId: 'short' }, 60),
    ).rejects.toThrow('Invalid ticket binding');
    await expect(
      redis.issueConnectTicket(ticketHash, binding, 0),
    ).rejects.toThrow('TTL must be a positive integer');
    assert({
      given: 'an invalid hash, binding or TTL',
      should: 'issue no Redis command',
      actual: commands,
      expected: [],
    });
  });
});

describe('consumeConnectTicket', () => {
  test('accepts a matching binding and deletes it atomically (single use)', async () => {
    const { redis, commands } = createTestRedis(
      undefined,
      new Map([[`test:v1:ticket:${ticketHash}`, JSON.stringify(binding)]]),
    );

    const first = await redis.consumeConnectTicket(ticketHash, origin);
    const second = await redis.consumeConnectTicket(ticketHash, origin);

    assert({
      given: 'a ticket consumed twice',
      should: 'accept it once, by GETDEL, and reject the replay as not-found',
      actual: [
        first,
        second,
        commands.filter(({ command }) => command === 'GETDEL').length,
      ],
      expected: [
        { accepted: true, userId, sessionId },
        { accepted: false, reason: 'not-found' },
        2,
      ],
    });
  });

  test('rejects, but still consumes, a binding for a different origin', async () => {
    const { redis } = createTestRedis(
      undefined,
      new Map([[`test:v1:ticket:${ticketHash}`, JSON.stringify(binding)]]),
    );

    const mismatched = await redis.consumeConnectTicket(
      ticketHash,
      'https://evil.example',
    );
    const replay = await redis.consumeConnectTicket(ticketHash, origin);

    assert({
      given: 'a binding whose origin differs from the connecting origin',
      should:
        'reject as origin-mismatch, and consume it so a replay finds nothing',
      actual: [mismatched, replay],
      expected: [
        { accepted: false, reason: 'origin-mismatch' },
        { accepted: false, reason: 'not-found' },
      ],
    });
  });

  test('rejects an unknown or expired ticket as not-found', async () => {
    const { redis } = createTestRedis();
    assert({
      given: 'a hash with no stored binding',
      should: 'answer not-found',
      actual: await redis.consumeConnectTicket(ticketHash, origin),
      expected: { accepted: false, reason: 'not-found' },
    });
  });

  test('rejects a malformed stored value rather than throwing', async () => {
    const { redis } = createTestRedis(
      undefined,
      new Map([[`test:v1:ticket:${ticketHash}`, 'not json']]),
    );
    assert({
      given: 'a stored value that is not the expected binding shape',
      should: 'answer malformed',
      actual: await redis.consumeConnectTicket(ticketHash, origin),
      expected: { accepted: false, reason: 'malformed' },
    });
  });

  test('refuses an invalid hash or empty expected origin before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(
      redis.consumeConnectTicket('not-a-hash', origin),
    ).rejects.toThrow('Invalid ticket hash');
    await expect(redis.consumeConnectTicket(ticketHash, '')).rejects.toThrow(
      'Invalid expected origin',
    );
    assert({
      given: 'an invalid hash or empty expected origin',
      should: 'issue no Redis command',
      actual: commands,
      expected: [],
    });
  });

  test('propagates outage and reports it without swallowing', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const outageRedis = createOfflineRedis(events);
    await expect(
      outageRedis.consumeConnectTicket(ticketHash, origin),
    ).rejects.toThrow('offline');
    assert({
      given: 'an unreachable Redis',
      should: 'emit a failure event naming the operation',
      actual: events,
      expected: [
        {
          event: 'redis.command.failed',
          fields: { operation: 'consumeConnectTicket' },
        },
      ],
    });
  });
});

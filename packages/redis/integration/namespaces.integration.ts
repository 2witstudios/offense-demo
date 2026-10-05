import { expect } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import {
  clearAuthRateLimits,
  deleteNamespace,
  listNamespaces,
} from '../src/namespaces';
import { requireTestServices } from '@offense-demo/config';
import { openTestRedis, testNamespace } from '../src/testing';

setupRitewayBun();

const { redisUrl: url } = requireTestServices(process.env);

// A unique prefix: these tests only ever see and delete their own keys.
const prefix = testNamespace(createId());

/** The real client, recording every command so the test can audit them. */
const recordingClient = () => {
  const client = openTestRedis(url);
  const commands: string[] = [];
  return {
    commands,
    client,
    send: (command: string, args: string[]) => {
      commands.push(command.toUpperCase());
      return client.send(command, args);
    },
  };
};

/** Both deletion helpers share this contract: never FLUSHDB/FLUSHALL. */
const assertUnlinkedNeverFlushed = (
  commands: readonly string[],
  given: string,
) =>
  assert({
    given,
    should: 'use UNLINK and never FLUSHDB or FLUSHALL',
    actual: {
      flush: commands.filter((command) => command.startsWith('FLUSH')),
      unlink: commands.includes('UNLINK'),
    },
    expected: { flush: [], unlink: true },
  });

test('deletes exactly one namespace by SCAN and UNLINK, never FLUSH*', async () => {
  const redis = recordingClient();
  const keys = {
    target: [`${prefix}-wt-a:v1:x`, `${prefix}-wt-a:v1:y`],
    // Shares the textual prefix `<p>-wt-a` but is another namespace.
    sibling: [`${prefix}-wt-ab:v1:x`, `${prefix}-wt-a-e2e:v1:x`],
    main: [`${prefix}:v1:x`],
  };
  try {
    // More keys than one SCAN page, so the cursor loop is exercised. Issued
    // together so Bun pipelines them instead of paying one round trip each.
    const bulk = Array.from(
      { length: 1200 },
      (_, index) => `${prefix}-wt-a:v1:bulk${index}`,
    );
    await Promise.all(
      [...keys.target, ...keys.sibling, ...keys.main, ...bulk].map((key) =>
        redis.client.send('SET', [key, '1', 'EX', '60']),
      ),
    );

    assert({
      given: 'keys in a namespace, a textual-prefix sibling and its e2e twin',
      should: 'list each distinct namespace under the prefix',
      actual: await listNamespaces(redis, `${prefix}-wt-`),
      expected: [`${prefix}-wt-a`, `${prefix}-wt-a-e2e`, `${prefix}-wt-ab`],
    });
    const listed = redis.commands.length;
    assert({
      given: 'a namespace with more keys than one SCAN page',
      should: 'delete every one of its keys',
      actual: await deleteNamespace(redis, `${prefix}-wt-a`),
      expected: 1202,
    });
    const deletion = redis.commands.slice(listed);
    assert({
      given: 'the 1,202-key namespace deleted',
      should:
        'send one UNLINK per SCAN page at most, never a command per key (ISSUE-192: per-key round trips overran a 30 s teardown)',
      actual: {
        perKey: deletion.filter(
          (command) => command !== 'SCAN' && command !== 'UNLINK',
        ),
        batched:
          deletion.filter((command) => command === 'UNLINK').length <=
          deletion.filter((command) => command === 'SCAN').length,
      },
      expected: { perKey: [], batched: true },
    });

    const remaining = await Promise.all(
      [...keys.target, ...keys.sibling, ...keys.main].map(async (key) => [
        key,
        await redis.client.exists(key),
      ]),
    );
    assert({
      given: 'the namespace deleted',
      should: 'keep sibling, e2e and main namespace keys',
      actual: Object.fromEntries(remaining),
      expected: {
        [keys.target[0]!]: false,
        [keys.target[1]!]: false,
        [keys.sibling[0]!]: true,
        [keys.sibling[1]!]: true,
        [keys.main[0]!]: true,
      },
    });
    assertUnlinkedNeverFlushed(
      redis.commands,
      'every command the deletion issued',
    );
  } finally {
    for (const namespace of [
      `${prefix}-wt-a`,
      `${prefix}-wt-ab`,
      `${prefix}-wt-a-e2e`,
      prefix,
    ])
      await deleteNamespace(redis, namespace);
    redis.client.close();
  }
});

test('AUTH-7.6: clears only the rl sub-namespace, leaving presence and ticket keys', async () => {
  const redis = recordingClient();
  const keys = {
    rateLimit: [`${prefix}:v1:rl:a`, `${prefix}:v1:rl:b`],
    presence: [`${prefix}:v1:presence:room1`],
    ticket: [`${prefix}:v1:ticket:t1`],
  };
  try {
    await Promise.all(
      [...keys.rateLimit, ...keys.presence, ...keys.ticket].map((key) =>
        redis.client.send('SET', [key, '1', 'EX', '60']),
      ),
    );

    assert({
      given: 'a namespace holding rate-limit, presence and ticket keys',
      should: 'delete only the rate-limit keys',
      actual: await clearAuthRateLimits(redis, prefix),
      expected: 2,
    });

    const remaining = await Promise.all(
      [...keys.rateLimit, ...keys.presence, ...keys.ticket].map(async (key) => [
        key,
        await redis.client.exists(key),
      ]),
    );
    assert({
      given: 'the rate-limit sub-namespace cleared',
      should: 'leave presence and ticket keys in place',
      actual: Object.fromEntries(remaining),
      expected: {
        [keys.rateLimit[0]!]: false,
        [keys.rateLimit[1]!]: false,
        [keys.presence[0]!]: true,
        [keys.ticket[0]!]: true,
      },
    });
    assertUnlinkedNeverFlushed(
      redis.commands,
      'every command the clear issued',
    );
  } finally {
    await deleteNamespace(redis, prefix);
    redis.client.close();
  }
});

test('refuses namespaces and prefixes that could widen the match', async () => {
  const redis = recordingClient();
  try {
    for (const hostile of [
      '*',
      'a*',
      'a?',
      'a[b]',
      'A',
      '',
      'a:b',
      `a${'b'.repeat(63)}`,
    ]) {
      await expect(deleteNamespace(redis, hostile)).rejects.toThrow(
        /namespace/,
      );
      await expect(listNamespaces(redis, hostile)).rejects.toThrow(/namespace/);
    }
    assert({
      given: 'hostile namespaces and prefixes',
      should: 'reject them before sending any command',
      actual: redis.commands,
      expected: [],
    });
  } finally {
    redis.client.close();
  }
});

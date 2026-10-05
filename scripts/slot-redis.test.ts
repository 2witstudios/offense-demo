import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { testRedisDatabase } from '@offense-demo/config';
import { slotEnvValues } from './slot-env';
import { deriveSlot, slotMismatches, worktreeSlot } from './slot-model';
import {
  clearTestNamespaces,
  configValue,
  openOwnTestRedis,
  redisDatabaseRefusal,
  redisDatabasesNeeded,
  requireRedisDatabases,
} from './slot-redis';

setupRitewayBun();

const env = {
  DATABASE_URL: 'postgres://offense_demo:pw@localhost:15432/offense_demo',
  REDIS_URL: 'redis://localhost:6379',
};

describe('slot test Redis database (ISSUE-237)', () => {
  test('every worktree gets its own test Redis database, never a shared one', () => {
    const urlOf = (block: number) =>
      slotEnvValues({ slot: worktreeSlot('abc'), env, portBlock: block })
        .TEST_REDIS_URL;

    assert({
      given: 'the first, second and last port blocks',
      should:
        'select Redis database 2 + block: 3, 4 and 501, above dev (0), main test (1) and e2e (2)',
      actual: [urlOf(1), urlOf(2), urlOf(499)],
      expected: [
        'redis://localhost:6379/3',
        'redis://localhost:6379/4',
        'redis://localhost:6379/501',
      ],
    });
    assert({
      given: 'the last port block, and the main checkout',
      should:
        'need a server with at least 502 databases, and main keep database 1',
      actual: [
        testRedisDatabase(499),
        redisDatabasesNeeded(499),
        testRedisDatabase(),
      ],
      expected: [501, 502, 1],
    });
  });

  test('reads CONFIG GET replies in either protocol shape', () => {
    assert({
      given: 'a RESP3 map, a RESP2 list, a Map and an empty reply',
      should: 'find the databases value in each, and none in the last',
      actual: [
        configValue({ databases: '512' }, 'databases'),
        configValue(['databases', '16'], 'databases'),
        configValue(new Map([['databases', '64']]), 'databases'),
        configValue([], 'databases'),
        configValue({}, 'databases'),
      ],
      expected: ['512', '16', '64', undefined, undefined],
    });
  });

  test('a Redis with too few databases is refused with the operator step', () => {
    const refusal = redisDatabaseRefusal({ available: 16, block: 14 });

    assert({
      given:
        'a 16-database Redis: block 13 needs database 15, block 14 needs 16; and a 512-database Redis for the last block',
      should: 'accept what fits and refuse what does not',
      actual: [
        redisDatabaseRefusal({ available: 16, block: 13 }),
        refusal === undefined,
        redisDatabaseRefusal({ available: 512, block: 499 }),
        redisDatabaseRefusal({ available: 16 }),
      ],
      expected: [undefined, false, undefined, undefined],
    });
    assert({
      given: 'the refusal for block 14 on 16 databases',
      should: 'name the database it needs and the one-time recreate command',
      actual: [
        refusal?.includes('offers 16 databases'),
        refusal?.includes('test database is 16'),
        refusal?.includes('up -d --force-recreate redis'),
      ],
      expected: [true, true, true],
    });
  });

  test('asks the server before a slot is written', async () => {
    const reply = (databases: string) => ({
      send: async () => ({ databases }),
    });

    const outcomes = await Promise.all(
      [
        requireRedisDatabases(reply('16'), 13),
        requireRedisDatabases(reply('16'), 14),
        requireRedisDatabases({ send: async () => ({}) }, 1),
      ].map((attempt) =>
        attempt.then(
          () => 'ok',
          (error: Error) => error.message.slice(0, 26),
        ),
      ),
    );

    assert({
      given:
        'a 16-database server for blocks 13 and 14, and a reply with no databases value',
      should: 'accept block 13 and refuse block 14 and the unreadable reply',
      actual: outcomes,
      expected: [
        'ok',
        'The shared Redis offers 16',
        'The shared Redis offers 0 ',
      ],
    });
  });

  test('a client is opened only on the worktree’s own database and server', () => {
    const server = 'redis://localhost:6379';
    const opened = [
      { TEST_REDIS_URL: `${server}/13`, REDIS_URL: server, PORT: '13110' },
      { TEST_REDIS_URL: `${server}/5`, REDIS_URL: server, PORT: '13110' },
      { TEST_REDIS_URL: `${server}/0`, REDIS_URL: server, PORT: '13110' },
      { TEST_REDIS_URL: `${server}/2`, REDIS_URL: server, PORT: '13110' },
      { TEST_REDIS_URL: `${server}/512`, REDIS_URL: server, PORT: '13110' },
      { TEST_REDIS_URL: `${server}/1`, REDIS_URL: server, PORT: '13110' },
      { TEST_REDIS_URL: `${server}/13`, REDIS_URL: server, PORT: '13115' },
      {
        TEST_REDIS_URL: 'redis://127.0.0.1:6391/13',
        REDIS_URL: server,
        PORT: '13110',
      },
      {
        TEST_REDIS_URL: 'redis://cache.example.com:6379/13',
        REDIS_URL: server,
        PORT: '13110',
      },
      { TEST_REDIS_URL: `${server}/13`, PORT: '13110' },
      { TEST_REDIS_URL: undefined, REDIS_URL: server, PORT: '13110' },
      {
        TEST_REDIS_URL: 'redis://127.0.0.1/13',
        REDIS_URL: server,
        PORT: '13110',
      },
    ].map(openOwnTestRedis);

    assert({
      given:
        'its own database, another slot’s, dev, e2e, 512, main’s, a PORT naming no block, another port, another host, no REDIS_URL, no URL, and another spelling of the same server',
      should: 'open a client for the first and the same-server spelling only',
      actual: opened.map((client) => client !== undefined),
      expected: [
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ],
    });
    for (const client of opened) client?.close();
  });

  test('doctor’s ownership check reports a test Redis that is not the slot’s own', () => {
    const slot = worktreeSlot('abc');
    const own = { ...env, ...slotEnvValues({ slot, env, portBlock: 11 }) };
    const mismatches = (url: string) =>
      slotMismatches(slot, { ...own, TEST_REDIS_URL: url });
    const main = {
      ...env,
      ...slotEnvValues({
        slot: deriveSlot({
          checkout: '/repo/offense-demo',
          mainCheckout: '/repo/offense-demo',
        }),
        env,
      }),
    };

    assert({
      given:
        'a worktree on its own database, another slot’s, dev and e2e; main on 1 and on 0',
      should: 'report every database that is not exactly the slot’s own',
      actual: [
        mismatches('redis://localhost:6379/13'),
        mismatches('redis://localhost:6379/5'),
        mismatches('redis://localhost:6379/0'),
        mismatches('redis://localhost:6379/2'),
        mismatches('redis://127.0.0.1:6391/13'),
        mismatches('redis://127.0.0.1:6379/13'),
        slotMismatches(
          deriveSlot({
            checkout: '/repo/offense-demo',
            mainCheckout: '/repo/offense-demo',
          }),
          main,
        ),
        slotMismatches(
          deriveSlot({
            checkout: '/repo/offense-demo',
            mainCheckout: '/repo/offense-demo',
          }),
          { ...main, TEST_REDIS_URL: 'redis://localhost:6379/0' },
        ),
      ],
      expected: [
        [],
        [
          "TEST_REDIS_URL names Redis database 5, expected this slot's own database 13 (run bun slot:up)",
        ],
        [
          "TEST_REDIS_URL names Redis database 0, expected this slot's own database 13 (run bun slot:up)",
        ],
        [
          "TEST_REDIS_URL names Redis database 2, expected this slot's own database 13 (run bun slot:up)",
        ],
        [
          "TEST_REDIS_URL names a different Redis server than REDIS_URL, expected this slot's shared Redis (run bun slot:up)",
        ],
        [],
        [],
        [
          "TEST_REDIS_URL names Redis database 0, expected this slot's own database 1 (run bun slot:up)",
        ],
      ],
    });
  });

  test('slot:down clears every t3- namespace and nothing else', async () => {
    const keys = new Set([
      't3-a:v1:x',
      't3-a:v1:y',
      't3-b:v1:x',
      'offense-demo-wt-abc:v1:session',
    ]);
    const client = {
      send: async (command: string, args: string[]) => {
        if (command === 'SCAN') {
          const prefix = (args[args.indexOf('MATCH') + 1] ?? '').replace(
            /\*$/,
            '',
          );
          return ['0', [...keys].filter((key) => key.startsWith(prefix))];
        }
        return args.filter((key) => keys.delete(key)).length;
      },
    };

    const removed = await clearTestNamespaces(client);

    assert({
      given: 'two test namespaces with three keys and a dev namespace key',
      should: 'remove the three test keys and keep the dev key',
      actual: { removed, left: [...keys] },
      expected: { removed: 3, left: ['offense-demo-wt-abc:v1:session'] },
    });
    assert({
      given: 'no client (the URL named a database the slot does not own)',
      should: 'remove nothing',
      actual: await clearTestNamespaces(undefined),
      expected: 0,
    });
  });
});

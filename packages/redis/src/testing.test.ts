import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import './index';
import './presence-scripts';
import { registeredScripts } from './script-registry';
import {
  TEST_KEY_TTL_MAX_MS,
  TEST_NAMESPACE_PREFIX,
  TEST_RUN_MAX_MS,
  testNamespace,
  wrapTestRedis,
} from './testing';

setupRitewayBun();

type Sent = { readonly command: string; readonly args: readonly string[] };

/** Records what reaches the wire; every command answers with `reply`. */
function recordingClient(reply: unknown = 'OK') {
  const sent: Sent[] = [];
  const client = {
    connected: true,
    async send(command: string, args: string[]) {
      sent.push({ command, args });
      return reply;
    },
    async connect() {},
    close() {},
  };
  return { client: client as never, sent };
}

// Any script the adapter registered: loading the modules above registers them.
const consumeScriptForTests = [...registeredScripts()][0] ?? '';
const MAX = 7_200_000;
const NS = 't3-abcdefghij';
const capOf = (sent: readonly Sent[], key: string) =>
  sent.find(
    ({ command, args }) =>
      command === 'EVAL' && args[0]?.includes('PTTL') && args.includes(key),
  );

describe('test namespaces', () => {
  test('carry the sweepable prefix and fit REDIS_NAMESPACE', () => {
    assert({
      given: 'a cuid2',
      should: 'name a t3- namespace of ten id characters',
      actual: {
        namespace: testNamespace('abcdefghijklmnopqrstuvwx'),
        prefix: TEST_NAMESPACE_PREFIX,
      },
      expected: { namespace: NS, prefix: 't3-' },
    });
  });

  test('a key lives well past a run, and a run is bounded below the key limit', () => {
    assert({
      given: 'the run and key limits',
      should: 'let a key outlive the idle window the sweep uses',
      actual: TEST_KEY_TTL_MAX_MS > TEST_RUN_MAX_MS,
      expected: true,
    });
  });
});

describe('the wrapper a suite is handed is structural (ISSUE-274)', () => {
  test('exposes a fixed set of methods and no constructor, prototype or raw handle', () => {
    const { client } = recordingClient();
    const redis = wrapTestRedis(client, { scripts: false });

    assert({
      given: 'a wrapped test client',
      should:
        'be a frozen object with no prototype whose only members are the guarded methods, so there is no constructor to build a raw client from and no handle to reach one through',
      actual: {
        prototype: Object.getPrototypeOf(redis),
        constructorMember: (redis as unknown as Record<string, unknown>)
          .constructor,
        frozen: Object.isFrozen(redis),
        members: Reflect.ownKeys(redis).map(String).sort(),
      },
      expected: {
        prototype: null,
        constructorMember: undefined,
        frozen: true,
        members: [
          'close',
          'connect',
          'connected',
          'del',
          'exists',
          'get',
          'getdel',
          'ping',
          'pttl',
          'send',
        ],
      },
    });
    expect(
      () =>
        new (
          redis as unknown as { constructor: new (url: string) => unknown }
        ).constructor('redis://localhost'),
    ).toThrow('not a constructor');
  });

  test('every method goes through the guard, including the helpers', async () => {
    const { client, sent } = recordingClient(1);
    const redis = wrapTestRedis(client, { scripts: false });

    await redis.get(`${NS}:v1:a`);
    await redis.del(`${NS}:v1:a`);
    await redis.exists(`${NS}:v1:a`);
    await redis.pttl(`${NS}:v1:a`);
    await redis.getdel(`${NS}:v1:a`);
    await redis.ping();

    assert({
      given: 'the convenience methods',
      should: 'each become one guarded command, and nothing else is sent',
      actual: sent.map(({ command }) => command),
      expected: ['GET', 'DEL', 'EXISTS', 'PTTL', 'GETDEL', 'PING'],
    });
    assert({
      given: 'the lifecycle members',
      should: 'reflect the real connection state',
      actual: redis.connected,
      expected: true,
    });
  });
});

describe('wrapTestRedis bounds expiry (ISSUE-237)', () => {
  test('a SET with no expiry gets one in the same command', async () => {
    const { client, sent } = recordingClient();
    const redis = wrapTestRedis(client, { scripts: true, maxTtlMs: MAX });

    await redis.send('SET', [`${NS}:v1:k`, 'v']);

    assert({
      given: 'a SET that forgot its expiry',
      should: 'reach Redis as SET ... PX <ceiling>, never immortal',
      actual: sent[0],
      expected: {
        command: 'SET',
        args: [`${NS}:v1:k`, 'v', 'PX', String(MAX)],
      },
    });
  });

  test('a SET with its own short expiry is left as written, then capped', async () => {
    const { client, sent } = recordingClient();
    const redis = wrapTestRedis(client, { scripts: true, maxTtlMs: MAX });

    await redis.send('SET', [`${NS}:v1:k`, 'v', 'EX', '60']);

    assert({
      given: 'a SET EX 60',
      should: 'keep the 60 s expiry and follow with the ceiling script',
      actual: {
        first: sent[0],
        capped: capOf(sent, `${NS}:v1:k`) !== undefined,
      },
      expected: {
        first: { command: 'SET', args: [`${NS}:v1:k`, 'v', 'EX', '60'] },
        capped: true,
      },
    });
  });

  test('every key a registered script declares is capped after it runs', async () => {
    const { client, sent } = recordingClient(1);
    const redis = wrapTestRedis(client, { scripts: true, maxTtlMs: MAX });

    await redis.send('EVAL', [consumeScriptForTests, '2', 'k1', 'k2', 'argv']);

    const cap = capOf(sent, 'k1');
    assert({
      given: 'a registered script declaring two keys',
      should: 'cap both keys in one follow-up script at the ceiling',
      actual: cap && {
        keyCount: cap.args[1],
        keys: cap.args.slice(2, 4),
        ceiling: cap.args[4],
      },
      expected: { keyCount: '2', keys: ['k1', 'k2'], ceiling: String(MAX) },
    });
  });

  test('a refused command is never sent, and a write returns its own reply', async () => {
    const { client, sent } = recordingClient('the-reply');
    const redis = wrapTestRedis(client, { scripts: true, maxTtlMs: MAX });

    await expect(redis.send('FLUSHDB', [])).rejects.toThrow(
      'Test Redis client refuses',
    );
    assert({
      given: 'a refused FLUSHDB then a SET',
      should:
        'send nothing for the first and return SET’s reply for the second',
      actual: {
        reply: await redis.send('SET', [`${NS}:v1:k`, 'v', 'EX', '5']),
        refusedSent: sent.some(({ command }) => command === 'FLUSHDB'),
      },
      expected: { reply: 'the-reply', refusedSent: false },
    });
  });

  test('a write whose keys cannot be attributed is refused, not sent', async () => {
    const { client, sent } = recordingClient();
    const redis = wrapTestRedis(client, { scripts: true, maxTtlMs: MAX });

    await expect(
      redis.send('EVAL', [consumeScriptForTests, 'x']),
    ).rejects.toThrow('cannot bound the expiry of EVAL');
    assert({
      given: 'a script whose key count is not a number',
      should: 'never reach Redis',
      actual: sent,
      expected: [],
    });
  });

  test('negative control: reads, deletes and scoped scans pass through untouched', async () => {
    const { client, sent } = recordingClient();
    const redis = wrapTestRedis(client, { scripts: false });

    await redis.send('PTTL', [`${NS}:v1:k`]);
    await redis.send('UNLINK', [`${NS}:v1:k`]);
    await redis.send('scan', ['0', 'MATCH', `${NS}:*`, 'COUNT', '500']);
    await redis.send('KEYS', [`${NS}:*`]);

    assert({
      given: 'PTTL, UNLINK, and a scan and KEYS scoped to one namespace',
      should: 'send exactly those commands',
      actual: sent.map(({ command }) => command),
      expected: ['PTTL', 'UNLINK', 'scan', 'KEYS'],
    });
  });
});

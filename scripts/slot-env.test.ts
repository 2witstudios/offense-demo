import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readEnvValue, rewriteEnv, slotEnvValues } from './slot-env';
import { deriveSlot, slotMismatches, worktreeSlot } from './slot-model';
import { slotNaming } from './slot-naming';

setupRitewayBun();

const main = '/repo/offense-demo';
// The main slot's database is the slug's snake form, its namespace the slug.
const { databaseBase: mainDatabase, namespaceBase: mainNamespace } =
  slotNaming('offense-demo');

describe('.env ownership check', () => {
  const slot = worktreeSlot('abc');
  // A real .env carries REDIS_URL beside the values slot:up writes.
  const own = {
    REDIS_URL: 'redis://localhost:6379',
    ...slotEnvValues({
      slot,
      env: {
        DATABASE_URL: 'postgres://offense_demo:pw@localhost:15432/offense_demo',
        REDIS_URL: 'redis://localhost:6379',
      },
      portBlock: 1,
    }),
  };

  test('accepts a .env written for this slot', () => {
    assert({
      given: 'values slot:up wrote for this worktree',
      should: 'report no mismatch',
      actual: slotMismatches(slot, own),
      expected: [],
    });
  });

  test('names every value that points at another slot', () => {
    assert({
      given: 'a .env copied from the main checkout',
      should: 'name each mismatched variable and the expected value',
      actual: slotMismatches(slot, {
        DATABASE_URL: 'postgres://offense_demo:pw@localhost:15432/offense_demo',
        TEST_DATABASE_URL:
          'postgres://offense_demo:pw@localhost:15432/offense_demo_test',
        REDIS_NAMESPACE: mainNamespace,
        E2E_DATABASE_URL: own.E2E_DATABASE_URL,
      }),
      expected: [
        `DATABASE_URL names "${mainDatabase}", expected "offense_demo_wt_abc"`,
        'TEST_DATABASE_URL names "offense_demo_test", expected "offense_demo_wt_abc_test"',
        `REDIS_NAMESPACE names "${mainNamespace}", expected "offense-demo-wt-abc"`,
        'E2E_REDIS_NAMESPACE is unset, expected "offense-demo-wt-abc-e2e"',
      ],
    });
  });
});

describe('slot .env values', () => {
  const env = {
    DATABASE_URL:
      'postgres://offense_demo:local-development-only@localhost:15432/offense_demo',
    TEST_DATABASE_URL:
      'postgres://offense_demo:local-development-only@localhost:15432/offense_demo_test',
    REDIS_URL: 'redis://localhost:6379',
  };

  test('main keeps the canonical values and ports', () => {
    assert({
      given: 'the main slot',
      should: 'write the canonical database URLs, namespaces and ports',
      actual: slotEnvValues({
        slot: deriveSlot({ checkout: main, mainCheckout: main }),
        env,
      }),
      expected: {
        DATABASE_URL:
          'postgres://offense_demo:local-development-only@localhost:15432/offense_demo',
        TEST_DATABASE_URL:
          'postgres://offense_demo:local-development-only@localhost:15432/offense_demo_test',
        REDIS_NAMESPACE: 'offense-demo',
        E2E_DATABASE_URL:
          'postgres://offense_demo_e2e:e2e-loopback-only@localhost:15432/offense_demo_e2e',
        E2E_REDIS_URL: 'redis://localhost:6379/2',
        E2E_REDIS_NAMESPACE: 'offense-demo-e2e',
        TEST_REDIS_URL: 'redis://localhost:6379/1',
        PORT: '3000',
        PUBLIC_APP_URL: 'http://localhost:3000',
        E2E_PORT: '3100',
        REALTIME_PORT: '3011',
      },
    });
  });

  test('a worktree keeps the server and moves database, namespace and ports', () => {
    assert({
      given: 'a worktree slot on port block 2 and a scratch server',
      should: 'keep host, port and credentials and replace only slot values',
      actual: slotEnvValues({
        slot: worktreeSlot('abc'),
        env: {
          DATABASE_URL:
            'postgres://offense_demo:pw@127.0.0.1:35432/offense_demo',
          REDIS_URL: 'redis://127.0.0.1:36379',
        },
        portBlock: 2,
      }),
      expected: {
        DATABASE_URL:
          'postgres://offense_demo:pw@127.0.0.1:35432/offense_demo_wt_abc',
        TEST_DATABASE_URL:
          'postgres://offense_demo:pw@127.0.0.1:35432/offense_demo_wt_abc_test',
        REDIS_NAMESPACE: 'offense-demo-wt-abc',
        E2E_DATABASE_URL:
          'postgres://offense_demo_e2e:e2e-loopback-only@127.0.0.1:35432/offense_demo_wt_abc_e2e',
        E2E_REDIS_URL: 'redis://127.0.0.1:36379/2',
        E2E_REDIS_NAMESPACE: 'offense-demo-wt-abc-e2e',
        TEST_REDIS_URL: 'redis://127.0.0.1:36379/4',
        PORT: '13020',
        PUBLIC_APP_URL: 'http://localhost:13020',
        E2E_PORT: '13021',
        REALTIME_PORT: '13025',
      },
    });
  });

  test('a worktree without a port block is refused', () => {
    expect(() => slotEnvValues({ slot: worktreeSlot('abc'), env })).toThrow(
      /port block/,
    );
  });
});

describe('.env rewriting', () => {
  test('replaces canonical assignments, appends missing keys, keeps the rest', () => {
    const content =
      '# comment\nDATABASE_URL=postgres://old/offense_demo\nSECRET=keep\nDATABASE_URL=postgres://dup/offense_demo\n';
    const result = rewriteEnv(content, {
      DATABASE_URL: 'postgres://new/offense_demo_wt_a',
      PORT: '13010',
    });
    assert({
      given: 'a .env with a duplicated key and a missing key',
      should: 'rewrite every assignment of the key and append the missing one',
      actual: result,
      expected: {
        changed: true,
        content:
          '# comment\nDATABASE_URL=postgres://new/offense_demo_wt_a\nSECRET=keep\nDATABASE_URL=postgres://new/offense_demo_wt_a\nPORT=13010\n',
      },
    });
  });

  test('is a no-op when every value already matches', () => {
    const content = 'PORT=13010\nSECRET=keep';
    assert({
      given: 'a .env already holding the slot values',
      should: 'report no change and return identical content',
      actual: rewriteEnv(content, { PORT: '13010' }),
      expected: { changed: false, content },
    });
  });

  test('reads the effective (last) assignment of a key', () => {
    assert({
      given: 'a .env with two assignments of a key',
      should: 'return the last value, or undefined when absent',
      actual: [
        readEnvValue('A=1\nB=2\nA=3\n', 'A'),
        readEnvValue('A=1\n', 'B'),
      ],
      expected: ['3', undefined],
    });
  });
});

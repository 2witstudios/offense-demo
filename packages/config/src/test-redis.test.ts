import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  expectedTestRedisDatabase,
  testRedisDatabase,
  testRedisRefusal,
} from './test-redis';

setupRitewayBun();

describe('test Redis database of a slot', () => {
  test('main is database 1 and a worktree is 2 + its port block', () => {
    assert({
      given: 'block 1, 11 and 499, and main',
      should: 'select 3, 13, 501 and 1',
      actual: [
        testRedisDatabase(1),
        testRedisDatabase(11),
        testRedisDatabase(499),
        testRedisDatabase(),
      ],
      expected: [3, 13, 501, 1],
    });
  });

  test('derives the slot’s own database from its PORT', () => {
    assert({
      given:
        'main (3000, or no PORT), worktree blocks 1, 11 and 499, ports naming no block, and an explicit kind',
      should:
        'expect 1 for main and 2 + block for a worktree, and nothing for the rest',
      actual: [
        expectedTestRedisDatabase('3000'),
        expectedTestRedisDatabase(undefined),
        expectedTestRedisDatabase('13010'),
        expectedTestRedisDatabase('13110'),
        expectedTestRedisDatabase('17990'),
        expectedTestRedisDatabase('13000'),
        expectedTestRedisDatabase('13115'),
        expectedTestRedisDatabase('18000'),
        expectedTestRedisDatabase('abc'),
        expectedTestRedisDatabase('13110', 'main'),
        expectedTestRedisDatabase(undefined, 'worktree'),
      ],
      expected: [
        1,
        1,
        3,
        13,
        501,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        undefined,
      ],
    });
  });

  test('refuses without naming a host, URL or credential', () => {
    const message = testRedisRefusal({
      testRedisUrl: 'redis://user:hunter2@cache.example.com:6390/13',
      redisUrl: 'redis://localhost:6379',
      expected: 13,
    });

    assert({
      given:
        'the slot’s own database number on another server with credentials',
      should: 'refuse and leak none of it',
      actual: [
        message?.includes('different Redis server'),
        /hunter2|cache\.example|6390/.test(message ?? ''),
      ],
      expected: [true, false],
    });
  });
});

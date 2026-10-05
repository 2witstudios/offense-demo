import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { deleteAllKeysWithoutExpiry } from './redis-whole-database';

setupRitewayBun();

/** An in-memory stand-in for SCAN (paged, no MATCH), PTTL and UNLINK. */
function fakeKeyspace(ttls: Readonly<Record<string, number>>, pageSize = 2) {
  const keys = new Map(Object.entries(ttls));
  const commands: string[] = [];
  return {
    keys: () => [...keys.keys()].sort(),
    commands,
    async send(command: string, args: string[]): Promise<unknown> {
      commands.push(command);
      if (command === 'SCAN') {
        const start = Number(args[0]);
        const page = [...keys.keys()].slice(start, start + pageSize);
        return [
          start + pageSize >= keys.size ? '0' : String(start + pageSize),
          page,
        ];
      }
      if (command === 'PTTL') return keys.get(args[0] ?? '') ?? -2;
      if (command === 'UNLINK')
        return args.filter((key) => keys.delete(key)).length;
      throw new Error(`fake keyspace: unexpected ${command}`);
    },
  };
}

describe('deleteAllKeysWithoutExpiry (the runner’s post-run scan)', () => {
  test('removes exactly the keys with no expiry, in every namespace, and names them', async () => {
    const redis = fakeKeyspace({
      'a:v1:forever': -1,
      'b:v1:forever': -1,
      'a:v1:soon': 5_000,
      'c:v1:soon': 60_000,
    });

    const removed = await deleteAllKeysWithoutExpiry(redis);

    assert({
      given: 'two immortal keys in different namespaces and two expiring keys',
      should:
        'unlink only the immortal ones, across pages, and report them sorted',
      actual: { removed, left: redis.keys() },
      expected: {
        removed: ['a:v1:forever', 'b:v1:forever'],
        left: ['a:v1:soon', 'c:v1:soon'],
      },
    });
  });

  test('walks the whole database with SCAN and never flushes', async () => {
    const redis = fakeKeyspace({ 'a:v1:x': 1000 });

    await deleteAllKeysWithoutExpiry(redis);

    assert({
      given: 'a run over a small database',
      should: 'use SCAN, PTTL and UNLINK only',
      actual: [...new Set(redis.commands)].sort(),
      expected: ['PTTL', 'SCAN'],
    });
  });
});

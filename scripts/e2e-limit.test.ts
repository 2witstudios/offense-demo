import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  claimFile,
  claimPlan,
  E2E_ENV,
  keepsClaim,
  lockDir,
  parseHeld,
  readLimit,
} from './e2e-limit';

setupRitewayBun();

describe('claimPlan', () => {
  test('claims a free slot under the limit and clears slots of dead runs', () => {
    assert({
      given: 'slot 0 held by a live run, slot 1 by a dead one, limit 2',
      should: 'clear the dead run by its own pid and claim slot 1',
      actual: claimPlan(
        [
          { slot: 0, pid: 10 },
          { slot: 1, pid: 11 },
        ],
        2,
        (pid) => pid === 10,
      ),
      expected: { claim: 1, stale: [{ slot: 1, pid: 11 }] },
    });
  });

  test('queues when every slot is held by a live run', () => {
    assert({
      given: 'two live runs and a limit of 2',
      should: 'claim nothing',
      actual: claimPlan(
        [
          { slot: 0, pid: 10 },
          { slot: 1, pid: 11 },
        ],
        2,
        () => true,
      ),
      expected: { claim: undefined, stale: [] },
    });
  });
});

describe('claimPlan counts every live run', () => {
  test('queues when the live claims reach the limit, whichever slots they hold', () => {
    assert({
      given: 'live claims on slots 1 and 2 and a limit of 1, then of 3',
      should: 'claim nothing at 1, and slot 0 at 3',
      actual: [
        claimPlan(
          [
            { slot: 1, pid: 10 },
            { slot: 2, pid: 11 },
          ],
          1,
          () => true,
        ).claim,
        claimPlan(
          [
            { slot: 1, pid: 10 },
            { slot: 2, pid: 11 },
          ],
          3,
          () => true,
        ).claim,
      ],
      expected: [undefined, 0],
    });
  });
});

describe('claims named by pid', () => {
  test('reads slot and pid from the file name, never from its content', () => {
    assert({
      given: 'two claims, a legacy empty-content name, and other files',
      should: 'return the named claims only',
      actual: parseHeld([
        'slot-0-4242.pid',
        'slot-1-77.pid',
        'slot-0.pid',
        '.DS_Store',
      ]),
      expected: [
        { slot: 0, pid: 4242 },
        { slot: 1, pid: 77 },
      ],
    });
  });

  test('keeps a claim only while no other live run holds the same slot', () => {
    const mine = { slot: 0, pid: 20 };
    assert({
      given:
        'my claim alone, beside a live rival on slot 0, beside a dead rival, and beside a live run on slot 1',
      should:
        'keep it, withdraw it, keep it, keep it, and withdraw when the live claims exceed the limit',
      actual: [
        keepsClaim([mine], mine, () => true, 2),
        keepsClaim([{ slot: 0, pid: 10 }, mine], mine, () => true, 2),
        keepsClaim([{ slot: 0, pid: 10 }, mine], mine, (pid) => pid === 20, 2),
        keepsClaim([{ slot: 1, pid: 10 }, mine], mine, () => true, 2),
        // Two racers on different slots at a limit of 1 both withdraw.
        keepsClaim([{ slot: 1, pid: 10 }, mine], mine, () => true, 1),
      ],
      expected: [true, false, true, true, false],
    });
  });
});

describe('claimFile', () => {
  test('never writes through a file or symlink already at the claim name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grd-6-claim-'));
    const target = join(dir, 'owner-file');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(dir, 'slot-0-1.pid'));
    writeFileSync(join(dir, 'slot-1-1.pid'), 'other run');
    assert({
      given:
        'a symlink planted at one claim name, a file at another, and a free name',
      should:
        'refuse the first two, leave both targets intact, and claim the free one',
      actual: [
        claimFile(join(dir, 'slot-0-1.pid')),
        claimFile(join(dir, 'slot-1-1.pid')),
        readFileSync(target, 'utf8'),
        readFileSync(join(dir, 'slot-1-1.pid'), 'utf8'),
        claimFile(join(dir, 'slot-2-1.pid')),
      ],
      expected: [false, false, 'keep', 'other run', true],
    });
  });
});

describe('readLimit', () => {
  test('reads a positive OFFENSE_DEMO_E2E_CONCURRENCY and defaults to 2', () => {
    assert({
      given: 'a set value, nothing, and nonsense',
      should: 'use the value, then the default twice',
      actual: [
        readLimit({ OFFENSE_DEMO_E2E_CONCURRENCY: '3' }),
        readLimit({}),
        readLimit({ OFFENSE_DEMO_E2E_CONCURRENCY: '0' }),
      ],
      expected: [3, 2, 2],
    });
  });
});

describe('one machine-wide pool', () => {
  test('uses one fixed lock directory whatever TMPDIR says', () => {
    assert({
      given: 'two TMPDIRs, and an explicit OFFENSE_DEMO_E2E_LOCK_DIR',
      should:
        'use /tmp/offense-demo-e2e-slots for both, and the explicit one when set',
      actual: [
        lockDir({ TMPDIR: '/var/folders/xy/T/' }),
        lockDir({ TMPDIR: '/tmp' }),
        lockDir({ OFFENSE_DEMO_E2E_LOCK_DIR: '/srv/e2e', TMPDIR: '/tmp' }),
      ],
      expected: [
        '/tmp/offense-demo-e2e-slots',
        '/tmp/offense-demo-e2e-slots',
        '/srv/e2e',
      ],
    });
  });

  test('passes the limit settings through turbo to test:e2e', async () => {
    const turbo = (await Bun.file(
      new URL('../turbo.json', import.meta.url),
    ).json()) as {
      tasks: Record<string, { passThroughEnv?: string[] }>;
    };
    assert({
      given: "turbo's strict env mode and the test:e2e task",
      should: 'pass every OFFENSE_DEMO_E2E_* setting through',
      actual: E2E_ENV.every((name) =>
        turbo.tasks['test:e2e']?.passThroughEnv?.includes(name),
      ),
      expected: true,
    });
  });
});

describe('e2e limit across real processes', () => {
  const root = new URL('..', import.meta.url).pathname;

  async function runConcurrently(limit: number): Promise<[number, number][]> {
    const dir = mkdtempSync(join(tmpdir(), 'grd-6-e2e-limit-'));
    const log = join(dir, 'log');
    const job = `const s=Date.now(); await Bun.sleep(300); require('node:fs').appendFileSync(${JSON.stringify(log)}, s + ' ' + Date.now() + '\\n');`;
    const runs = Array.from({ length: 3 }, () =>
      Bun.spawn(['bun', `${root}scripts/e2e-limit.ts`, 'bun', '-e', job], {
        env: {
          ...process.env,
          OFFENSE_DEMO_E2E_CONCURRENCY: String(limit),
          OFFENSE_DEMO_E2E_LOCK_DIR: join(dir, 'slots'),
          OFFENSE_DEMO_E2E_POLL_MS: '25',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
    const codes = await Promise.all(runs.map((run) => run.exited));
    if (codes.some((code) => code !== 0)) throw new Error(`exit ${codes}`);
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ').map(Number) as [number, number])
      .sort(([a], [b]) => a - b);
  }

  const overlaps = (runs: [number, number][]) =>
    runs.some(
      ([, end], index) => index + 1 < runs.length && runs[index + 1][0] < end,
    );

  test('queues runs beyond the limit instead of running them at once', async () => {
    assert({
      given: 'three concurrent runs under a limit of 1, then of 3',
      should: 'serialise them at 1 and overlap them at 3',
      actual: [
        overlaps(await runConcurrently(1)),
        overlaps(await runConcurrently(3)),
      ],
      expected: [false, true],
    });
  });
});

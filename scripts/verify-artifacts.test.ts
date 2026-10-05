import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { archiveE2eArtifacts, e2eArchiveName, runVerify } from './verify';

const quiet = {
  changedFiles: async () => ['scripts/verify.ts'],
  writeLog: (stage: string) => `logs/${stage}.log`,
  print: () => undefined,
};

setupRitewayBun();

describe('verify e2e failure artifacts', () => {
  test("keeps a failed browser run's artifacts and names where", async () => {
    const kept: string[] = [];
    const report = await runVerify({
      environment: {
        TEST_DATABASE_URL: 'postgres://localhost/offense_demo_test',
      },
      ...quiet,
      keepE2eArtifacts: () => {
        kept.push('e2e');
        return 'verify-logs/e2e-failures/2026-09-29T21-40-05Z-a8ee939';
      },
      run: async ({ args }) => ({
        code: args[1] === 'test:e2e' ? 1 : 0,
        output: '',
      }),
    });
    assert({
      given: 'an e2e stage that fails',
      should: 'archive its artifacts once and name the archive in the gate',
      actual: { kept, detail: report.gates[2]?.detail },
      expected: {
        kept: ['e2e'],
        detail:
          'exit 1; log logs/e2e.log; artifacts verify-logs/e2e-failures/2026-09-29T21-40-05Z-a8ee939',
      },
    });
  });

  test('keeps nothing when the browser run passes', async () => {
    const kept: string[] = [];
    await runVerify({
      environment: {
        TEST_DATABASE_URL: 'postgres://localhost/offense_demo_test',
      },
      ...quiet,
      keepE2eArtifacts: () => {
        kept.push('e2e');
        return 'unused';
      },
      run: async () => ({ code: 0, output: '' }),
    });
    assert({
      given: 'every stage passing',
      should: 'not archive anything',
      actual: kept,
      expected: [],
    });
  });

  test('names each archive by UTC time and commit, so no later run reuses it', () => {
    assert({
      given: 'a run at 21:40:05 UTC on commit a8ee939',
      should: 'give a path-safe name that sorts by time',
      actual: e2eArchiveName(new Date('2026-09-29T21:40:05.123Z'), 'a8ee939'),
      expected: '2026-09-29T21-40-05Z-a8ee939',
    });
  });

  test('copies the whole results folder into a new archive and leaves the source', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-archive-'));
    const from = join(scratch, 'test-results');
    mkdirSync(join(from, 'a-failed-test'), { recursive: true });
    writeFileSync(join(from, 'a-failed-test', 'trace.zip'), 'trace');
    writeFileSync(join(from, 'server-13050.log'), 'server log');
    const to = join(scratch, 'verify-logs', 'e2e-failures', 'run-1');
    const archived = archiveE2eArtifacts({ from, to });
    assert({
      given:
        "a results folder holding a failed test's trace and the server log",
      should: 'copy both into the archive and keep the source intact',
      actual: {
        archived,
        trace: readFileSync(join(to, 'a-failed-test', 'trace.zip'), 'utf8'),
        server: readFileSync(join(to, 'server-13050.log'), 'utf8'),
        source: readFileSync(join(from, 'server-13050.log'), 'utf8'),
      },
      expected: {
        archived: true,
        trace: 'trace',
        server: 'server log',
        source: 'server log',
      },
    });
  });

  test('archives nothing when there are no results to keep', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-archive-'));
    assert({
      given: 'no results folder (the browser run never started)',
      should: 'report that nothing was archived',
      actual: archiveE2eArtifacts({
        from: join(scratch, 'missing'),
        to: join(scratch, 'archive'),
      }),
      expected: false,
    });
  });
});

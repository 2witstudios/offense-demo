import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  checkoutCheck,
  createDoctorReport,
  formatDoctorReport,
  isMigrationCurrent,
  orphanCheck,
  puConfigCheck,
  readCommittedMigrationHashes,
  slotCheck,
  type DoctorCheck,
} from './doctor';
import { slotEnvValues } from './slot-env';
import { worktreeSlot } from './slot-model';
import { slotNaming } from './slot-naming';

setupRitewayBun();

describe('doctor report', () => {
  test('preserves the stable check order and derives overall health', () => {
    const report = createDoctorReport([
      { name: 'redis', status: 'pass', detail: 'PONG' },
      { name: 'bun-version', status: 'pass', detail: '1.4.2' },
      { name: 'env', status: 'fail', detail: 'DATABASE_URL' },
    ]);

    assert({
      given: 'doctor checks in arbitrary order with one failure',
      should: 'return an ordered report marked unhealthy',
      actual: report,
      expected: {
        ok: false,
        checks: [
          { name: 'bun-version', status: 'pass', detail: '1.4.2' },
          { name: 'env', status: 'fail', detail: 'DATABASE_URL' },
          { name: 'postgres', status: 'fail', detail: 'not checked' },
          { name: 'migration-currency', status: 'fail', detail: 'not checked' },
          { name: 'redis', status: 'pass', detail: 'PONG' },
          { name: 'boundaries', status: 'fail', detail: 'not checked' },
          { name: 'slot', status: 'fail', detail: 'not checked' },
          { name: 'slot-orphans', status: 'fail', detail: 'not checked' },
          { name: 'github-identity', status: 'fail', detail: 'not checked' },
          { name: 'identity-regime', status: 'fail', detail: 'not checked' },
          { name: 'pu-config', status: 'fail', detail: 'not checked' },
          { name: 'checkout', status: 'fail', detail: 'not checked' },
        ],
      },
    });
  });

  test('renders machine-readable and human-readable reports without changing data', () => {
    const report = createDoctorReport([
      { name: 'bun-version', status: 'pass', detail: '1.4.2' },
      { name: 'env', status: 'pass', detail: 'valid' },
      { name: 'postgres', status: 'pass', detail: 'reachable' },
      { name: 'migration-currency', status: 'pass', detail: '1 migration' },
      { name: 'redis', status: 'pass', detail: 'PONG' },
      { name: 'boundaries', status: 'pass', detail: 'verified' },
      { name: 'slot', status: 'pass', detail: 'offense-demo' },
      { name: 'slot-orphans', status: 'warn', detail: 'orphaned slots: gone' },
      {
        name: 'github-identity',
        status: 'pass',
        detail: 'autonomous as offense-demo-agent (GH_TOKEN, HTTPS push)',
      },
      {
        name: 'identity-regime',
        status: 'pass',
        detail: 'identity regime active (agent)',
      },
      {
        name: 'pu-config',
        status: 'pass',
        detail: 'agents start through scripts/agent-launch.sh',
      },
      { name: 'checkout', status: 'pass', detail: 'worktree on pu/x' },
    ]);

    assert({
      given: 'a healthy doctor report',
      should: 'render stable JSON',
      actual: JSON.parse(formatDoctorReport(report, true)),
      expected: report,
    });
    assert({
      given: 'a healthy doctor report',
      should: 'render a passing text summary',
      actual: formatDoctorReport(report, false),
      expected:
        'Offense Demo doctor: PASS\nPASS bun-version: 1.4.2\nPASS env: valid\nPASS postgres: reachable\nPASS migration-currency: 1 migration\nPASS redis: PONG\nPASS boundaries: verified\nPASS slot: offense-demo\nWARN slot-orphans: orphaned slots: gone\nPASS github-identity: autonomous as offense-demo-agent (GH_TOKEN, HTTPS push)\nPASS identity-regime: identity regime active (agent)\nPASS pu-config: agents start through scripts/agent-launch.sh\nPASS checkout: worktree on pu/x\n',
    });
  });
});

describe('slot checks', () => {
  const slot = worktreeSlot('abc');
  const env = {
    DATABASE_URL: 'postgres://offense_demo:pw@localhost:15432/offense_demo',
    TEST_DATABASE_URL:
      'postgres://offense_demo:pw@localhost:15432/offense_demo_test',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_NAMESPACE: 'offense-demo',
  };

  test('fails a worktree whose .env names another slot', () => {
    // The main database is the slug's snake form (scripts/slot-naming.ts).
    const mainDatabase = slotNaming('offense-demo').databaseBase;
    assert({
      given: 'a worktree .env copied from the main checkout',
      should: 'fail naming each mismatch and the fix',
      actual: slotCheck(slot, env),
      expected: {
        name: 'slot',
        status: 'fail',
        detail: `slot abc: DATABASE_URL names "${mainDatabase}", expected "offense_demo_wt_abc"; TEST_DATABASE_URL names "offense_demo_test", expected "offense_demo_wt_abc_test"; E2E_DATABASE_URL is unset, expected "offense_demo_wt_abc_e2e"; REDIS_NAMESPACE names "offense-demo", expected "offense-demo-wt-abc"; E2E_REDIS_NAMESPACE is unset, expected "offense-demo-wt-abc-e2e" (run bun slot:up)`,
      },
    });
  });

  test('passes a worktree whose .env slot:up wrote', () => {
    assert({
      given: 'the values slot:up writes',
      should: 'pass naming the slot',
      actual: slotCheck(slot, {
        REDIS_URL: env.REDIS_URL,
        ...slotEnvValues({ slot, env, portBlock: 1 }),
      }),
      expected: { name: 'slot', status: 'pass', detail: 'abc' },
    });
  });

  test('reports orphaned slots without failing the report', () => {
    const warned = orphanCheck(['gone', 'old']);
    assert({
      given: 'orphaned and no orphaned slots',
      should: 'warn with the prune command, and pass when none',
      actual: [
        warned,
        orphanCheck([]),
        createDoctorReport([warned]).checks.find(
          (check) => check.name === 'slot-orphans',
        )?.status,
      ],
      expected: [
        {
          name: 'slot-orphans',
          status: 'warn',
          detail: 'orphaned slots: gone, old (run bun slot:prune)',
        },
        { name: 'slot-orphans', status: 'pass', detail: 'none' },
        'warn',
      ],
    });
    assert({
      given: 'a report whose only non-pass check is a warning',
      should: 'stay healthy',
      actual: createDoctorReport([
        ...(
          [
            'bun-version',
            'env',
            'postgres',
            'migration-currency',
            'redis',
            'boundaries',
            'slot',
            'github-identity',
            'identity-regime',
            'pu-config',
            'checkout',
          ] as const
        ).map((name): DoctorCheck => ({ name, status: 'pass', detail: '' })),
        warned,
      ]).ok,
      expected: true,
    });
  });
});

describe('migration currency', () => {
  test('requires the applied migrations to exactly match the committed ones', () => {
    assert({
      given: 'committed and applied migration tags',
      should: 'accept an exact match and reject drift',
      actual: [
        isMigrationCurrent(['0000_baseline'], ['0000_baseline']),
        isMigrationCurrent(['0000_baseline'], []),
        isMigrationCurrent(
          ['0000_baseline'],
          ['0000_baseline', '0001_unexpected'],
        ),
      ],
      expected: [true, false, false],
    });
  });

  test('reads the hashes of committed migration SQL', async () => {
    const root = new URL('../packages/db/migrations/', import.meta.url)
      .pathname;
    const paths = [...new Bun.Glob('*/migration.sql').scanSync(root)].sort();
    const expected = await Promise.all(
      paths.map(async (path) =>
        new Bun.CryptoHasher('sha256')
          .update(await Bun.file(`${root}${path}`).bytes())
          .digest('hex'),
      ),
    );
    assert({
      given: 'the committed drizzle-kit 1.0 migration folders',
      should: 'return the sha256 the migrator records, in folder order',
      actual: {
        hashes: await readCommittedMigrationHashes(),
        startsAtBaseline: paths[0]?.endsWith('_baseline/migration.sql'),
      },
      expected: { hashes: expected, startsAtBaseline: true },
    });
  });
});

describe('checkout check', () => {
  test('warns, not fails, when the main checkout is off main', () => {
    assert({
      given: 'the main checkout on a feature branch, and a worktree',
      should: 'warn for the first and pass the second',
      actual: [
        checkoutCheck({ mainCheckout: true, branch: 'docs/x' }).status,
        checkoutCheck({ mainCheckout: false, branch: 'pu/x' }),
      ],
      expected: [
        'warn',
        { name: 'checkout', status: 'pass', detail: 'worktree on pu/x' },
      ],
    });
  });
});

describe('pu config check', () => {
  test('fails when pu has replaced the committed launcher configuration', () => {
    assert({
      given: 'a modified, a deleted and an untouched .pu/config.yaml',
      should: 'fail the first two and pass the last',
      actual: [
        puConfigCheck(' M .pu/config.yaml\n').status,
        puConfigCheck(' D .pu/config.yaml\n').status,
        puConfigCheck(''),
      ],
      expected: [
        'fail',
        'fail',
        {
          name: 'pu-config',
          status: 'pass',
          detail: 'agents start through scripts/agent-launch.sh',
        },
      ],
    });
  });
});

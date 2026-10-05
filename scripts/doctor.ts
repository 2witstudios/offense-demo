import { SQL, RedisClient } from 'bun';
import { readServerConfig } from '@offense-demo/config';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { serviceRefusal, slotMismatches, type Slot } from './slot-model';
import {
  inspectOrphans,
  liveSlotIds,
  openServices,
  resolveCheckout,
} from './slot-services';
import {
  assessGithubIdentity,
  identityRegime,
  regimeCheck,
} from './agent-identity';
import { sessionIsAgent } from './agent-session';
import { loadProjectConfig } from './project-config';
import { checkoutWarning, readCheckout } from './session-start';

const checkNames = [
  'bun-version',
  'env',
  'postgres',
  'migration-currency',
  'redis',
  'boundaries',
  'slot',
  'slot-orphans',
  'github-identity',
  'identity-regime',
  'pu-config',
  'checkout',
] as const;

type CheckName = (typeof checkNames)[number];
/** A warning is reported but does not fail the doctor. */
type CheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorCheck = {
  readonly name: CheckName;
  readonly status: CheckStatus;
  readonly detail: string;
};
export type DoctorReport = {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
};

const root = resolve(import.meta.dir, '..');

export function isMigrationCurrent(
  committedTags: readonly string[],
  appliedTags: readonly string[],
): boolean {
  return (
    committedTags.length === appliedTags.length &&
    committedTags.every((tag, index) => tag === appliedTags[index])
  );
}

/**
 * The hash drizzle-orm's migrator records for each committed migration, in
 * apply order: the sha256 of `<tag>/migration.sql`, folders in name order
 * (the drizzle-kit 1.0 layout, ADR 0038).
 */
export async function readCommittedMigrationHashes(): Promise<
  readonly string[]
> {
  const migrations = resolve(root, 'packages/db/migrations');
  const tags = (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    tags.map(async (tag) =>
      createHash('sha256')
        .update(await readFile(resolve(migrations, tag, 'migration.sql')))
        .digest('hex'),
    ),
  );
}

export function createDoctorReport(
  checks: readonly DoctorCheck[],
): DoctorReport {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const orderedChecks = checkNames.map(
    (name): DoctorCheck =>
      byName.get(name) ?? { name, status: 'fail', detail: 'not checked' },
  );
  return {
    ok: orderedChecks.every((check) => check.status !== 'fail'),
    checks: orderedChecks,
  };
}

export function formatDoctorReport(
  report: DoctorReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Offense Demo doctor: ${report.ok ? 'PASS' : 'FAIL'}`,
    ...report.checks.map(
      (check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`,
    ),
    '',
  ].join('\n');
}

function pass(name: CheckName, detail: string): DoctorCheck {
  return { name, status: 'pass', detail };
}

function fail(name: CheckName, detail: string): DoctorCheck {
  return { name, status: 'fail', detail };
}

/** Fails when this checkout's .env names another slot's data. */
export function slotCheck(
  slot: Slot,
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheck {
  const mismatches = slotMismatches(slot, env);
  return mismatches.length === 0
    ? pass('slot', slot.id)
    : fail(
        'slot',
        `slot ${slot.id}: ${mismatches.join('; ')} (run bun slot:up)`,
      );
}

export function orphanCheck(ids: readonly string[]): DoctorCheck {
  return ids.length === 0
    ? pass('slot-orphans', 'none')
    : {
        name: 'slot-orphans',
        status: 'warn',
        detail: `orphaned slots: ${ids.join(', ')} (run bun slot:prune)`,
      };
}

async function checkSlots(): Promise<readonly DoctorCheck[]> {
  let checkout;
  try {
    checkout = await resolveCheckout(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unresolved';
    return [fail('slot', detail), fail('slot-orphans', 'slot unresolved')];
  }
  const slot = slotCheck(checkout.slot, process.env);
  // The slot tooling's own refusals are shown as they are; connection
  // failures stay generic so no driver error text reaches the report.
  const refusal = serviceRefusal(process.env);
  if (refusal) return [slot, fail('slot-orphans', refusal)];
  let liveIds: readonly string[];
  try {
    liveIds = await liveSlotIds(checkout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'worktrees unread';
    return [slot, fail('slot-orphans', detail)];
  }
  let services;
  try {
    services = openServices(process.env);
    return [slot, orphanCheck((await inspectOrphans(services, liveIds)).ids)];
  } catch {
    return [slot, fail('slot-orphans', 'services unavailable')];
  } finally {
    await services?.close().catch(() => undefined);
  }
}

async function checkBunVersion(): Promise<DoctorCheck> {
  try {
    const expected = (
      await Bun.file(resolve(root, '.bun-version')).text()
    ).trim();
    return Bun.version === expected
      ? pass('bun-version', Bun.version)
      : fail('bun-version', `expected ${expected}, got ${Bun.version}`);
  } catch {
    return fail('bun-version', 'version file unavailable');
  }
}

function checkEnvironment(): DoctorCheck {
  try {
    readServerConfig(process.env);
    return pass('env', 'valid');
  } catch (error) {
    return fail('env', error instanceof Error ? error.message : 'invalid');
  }
}

async function checkPostgres(url: string | undefined): Promise<DoctorCheck> {
  if (!url) return fail('postgres', 'DATABASE_URL unavailable');
  let client: SQL | undefined;
  try {
    client = new SQL(url, { max: 1, connectionTimeout: 3 });
    await client`select 1`;
    return pass('postgres', 'reachable');
  } catch {
    return fail('postgres', 'unreachable');
  } finally {
    await client?.close({ timeout: 5 });
  }
}

async function checkMigrationCurrency(
  url: string | undefined,
): Promise<DoctorCheck> {
  if (!url) return fail('migration-currency', 'DATABASE_URL unavailable');
  let client: SQL | undefined;
  try {
    const committedHashes = await readCommittedMigrationHashes();
    client = new SQL(url, { max: 1, connectionTimeout: 3 });
    const rows = await client`
      select hash
      from drizzle.__drizzle_migrations
      order by created_at asc
    `;
    const appliedHashes = rows.map((row) => row.hash);
    if (
      !appliedHashes.every((hash): hash is string => typeof hash === 'string')
    )
      return fail(
        'migration-currency',
        'migration drift: non-string hash recorded',
      );
    if (!isMigrationCurrent(committedHashes, appliedHashes)) {
      const firstDivergence = committedHashes.findIndex(
        (hash, index) => appliedHashes[index] !== hash,
      );
      return fail(
        'migration-currency',
        firstDivergence === -1
          ? `migration drift: ${appliedHashes.length} applied migrations against ${committedHashes.length} committed migrations`
          : `migration drift: first divergence at migration ${firstDivergence + 1} of ${committedHashes.length}`,
      );
    }
    return pass(
      'migration-currency',
      `${committedHashes.length} migration${committedHashes.length === 1 ? '' : 's'}`,
    );
  } catch {
    return fail('migration-currency', 'migration table unavailable');
  } finally {
    await client?.close({ timeout: 5 });
  }
}

async function checkRedis(url: string | undefined): Promise<DoctorCheck> {
  if (!url) return fail('redis', 'REDIS_URL unavailable');
  let client: RedisClient | undefined;
  try {
    client = new RedisClient(url);
    await client.connect();
    return (await client.ping()) === 'PONG'
      ? pass('redis', 'PONG')
      : fail('redis', 'unexpected response');
  } catch {
    return fail('redis', 'unreachable');
  } finally {
    client?.close();
  }
}

async function checkBoundaries(): Promise<DoctorCheck> {
  const process = Bun.spawn(['bun', 'scripts/check-boundaries.ts'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await process.exited) === 0
    ? pass('boundaries', 'verified')
    : fail('boundaries', 'failed');
}

async function output(args: readonly string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn([...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = (await new Response(child.stdout).text()).trim();
    return (await child.exited) === 0 && text !== '' ? text : undefined;
  } catch {
    return undefined;
  }
}

async function checkGithubIdentity(): Promise<DoctorCheck> {
  const { owner } = loadProjectConfig(root);
  const [login, pushUrl, credentialHelper] = await Promise.all([
    output(['gh', 'api', 'user', '--jq', '.login']),
    output(['git', 'remote', 'get-url', '--push', 'origin']),
    output([
      'git',
      'config',
      '--get-urlmatch',
      'credential.helper',
      'https://github.com',
    ]),
  ]);
  const { status, detail } = assessGithubIdentity({
    autonomous: sessionIsAgent(process.env),
    login,
    tokenFromEnv: Boolean(process.env.GH_TOKEN),
    pushUrl,
    credentialHelper,
    owner,
  });
  return { name: 'github-identity', status, detail };
}

async function checkIdentityRegime(): Promise<DoctorCheck> {
  const commonDir = await output([
    'git',
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const regime = identityRegime(
    process.env,
    existsSync,
    commonDir ? dirname(commonDir) : undefined,
  );
  return {
    name: 'identity-regime',
    ...regimeCheck(regime, process.env.PU_AGENT_ID),
  };
}

/**
 * pu init writes its default config whenever .pu/manifest.json is missing (a
 * fresh clone), which would start agents without the identity launcher.
 */
export function puConfigCheck(porcelain: string): DoctorCheck {
  return porcelain.trim() === ''
    ? pass('pu-config', 'agents start through scripts/agent-launch.sh')
    : fail(
        'pu-config',
        '.pu/config.yaml differs from the committed launcher configuration (pu init rewrites it on a fresh clone): run git checkout -- .pu/config.yaml in the main checkout',
      );
}

async function checkPuConfig(): Promise<DoctorCheck> {
  const commonDir = await output([
    'git',
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const main = commonDir ? dirname(commonDir) : root;
  const status = await output([
    'git',
    '-C',
    main,
    'status',
    '--porcelain',
    '--',
    '.pu/config.yaml',
  ]);
  return puConfigCheck(status ?? '');
}

/** The main checkout off main is a warning (the session-start hook warns too). */
export function checkoutCheck(checkout: {
  readonly mainCheckout: boolean;
  readonly branch: string | undefined;
}): DoctorCheck {
  const warning = checkoutWarning(checkout);
  return warning
    ? { name: 'checkout', status: 'warn', detail: warning }
    : pass(
        'checkout',
        `${checkout.mainCheckout ? 'main checkout' : 'worktree'} on ${checkout.branch ?? 'detached HEAD'}`,
      );
}

export async function runDoctor(): Promise<DoctorReport> {
  const env = checkEnvironment();
  const [bunVersion, postgres, migrations, redis, boundaries, slots, identity] =
    await Promise.all([
      checkBunVersion(),
      checkPostgres(process.env.DATABASE_URL),
      checkMigrationCurrency(process.env.DATABASE_URL),
      checkRedis(process.env.REDIS_URL),
      checkBoundaries(),
      checkSlots(),
      checkGithubIdentity(),
    ]);
  return createDoctorReport([
    bunVersion,
    env,
    postgres,
    migrations,
    redis,
    boundaries,
    ...slots,
    identity,
    await checkIdentityRegime(),
    await checkPuConfig(),
    checkoutCheck(readCheckout(root)),
  ]);
}

if (import.meta.main) {
  const report = await runDoctor();
  process.stdout.write(
    formatDoctorReport(report, process.argv.includes('--json')),
  );
  process.exitCode = report.ok ? 0 : 1;
}

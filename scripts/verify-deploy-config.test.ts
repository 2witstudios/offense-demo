import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readFileSync } from 'node:fs';
import {
  EXPECTED_RELEASE_COMMAND,
  findAlwaysOnProblem,
  findDockerfileBunVersionProblem,
  findFlyDatabaseSecretProblem,
  findFlyReleaseCommandProblem,
  findMigrationCredentialProblem,
  findMigratorAppProblem,
  findWebReleaseCommandProblem,
  findWorkflowMigrationOrderProblem,
  verifyDeployConfig,
} from './verify-deploy-config';

setupRitewayBun();

const realDockerfile = readFileSync('apps/web/Dockerfile', 'utf8');
const realFlyToml = readFileSync('fly.toml', 'utf8');
const realMigratorToml = readFileSync('fly.migrate.toml', 'utf8');
const realWorkflow = readFileSync(
  '.github/workflows/deploy-staging.yml',
  'utf8',
);
const readRepoFile = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};
const realProbeWorkflow = readFileSync(
  '.github/workflows/auth-alerts.yml',
  'utf8',
);
const realBunVersion = readFileSync('.bun-version', 'utf8').trim();
const realStart = readFileSync('apps/web/src/server/start.ts', 'utf8');
const realMigrate = readFileSync('packages/db/scripts/migrate.ts', 'utf8');
const realShutdownBudget = readFileSync(
  'apps/web/src/server/shutdown-budget.ts',
  'utf8',
);

describe('findDockerfileBunVersionProblem', () => {
  test('the committed Dockerfile pins the committed .bun-version', () => {
    assert({
      given: 'the real Dockerfile and .bun-version',
      should: 'report no drift',
      actual: findDockerfileBunVersionProblem({
        dockerfile: realDockerfile,
        bunVersion: realBunVersion,
      }),
      expected: null,
    });
  });

  test('a Dockerfile pinned to a different Bun version', () => {
    assert({
      given: 'FROM oven/bun:1.0.0-slim AS base with .bun-version 1.4.2',
      should: 'report the drift',
      actual: findDockerfileBunVersionProblem({
        dockerfile: 'FROM oven/bun:1.0.0-slim AS base\n',
        bunVersion: '1.4.2',
      }),
      expected:
        'Dockerfile pins oven/bun:1.0.0-slim, but .bun-version is 1.4.2',
    });
  });

  test('a Dockerfile missing the base image line entirely', () => {
    assert({
      given: 'a Dockerfile with no base stage',
      should: 'report it missing rather than pass silently',
      actual: findDockerfileBunVersionProblem({
        dockerfile: 'FROM node:22 AS base\n',
        bunVersion: '1.4.2',
      }),
      expected: 'Dockerfile has no `FROM oven/bun:<version> AS base` line',
    });
  });
});

describe('findFlyReleaseCommandProblem', () => {
  test('the committed fly.migrate.toml keeps the migration release command', () => {
    assert({
      given: 'the real fly.migrate.toml',
      should: 'report no drift',
      actual: findFlyReleaseCommandProblem(realMigratorToml),
      expected: null,
    });
  });

  test('fly.toml with the release_command line removed', () => {
    assert({
      given: 'a [deploy] block with no release_command',
      should: 'report it missing',
      actual: findFlyReleaseCommandProblem('[deploy]\n'),
      expected: 'fly.migrate.toml has no `release_command` under [deploy]',
    });
  });

  test('fly.toml with an emptied release_command', () => {
    assert({
      given: 'release_command = ""',
      should: 'report it empty',
      actual: findFlyReleaseCommandProblem(
        '[deploy]\n  release_command = ""\n',
      ),
      expected: 'fly.migrate.toml release_command is empty',
    });
  });

  test('fly.toml with a wrong non-empty release_command', () => {
    assert({
      given: 'release_command = "true", which skips the migration entirely',
      should: 'report the mismatch, not pass silently',
      actual: findFlyReleaseCommandProblem(
        '[deploy]\n  release_command = "true"\n',
      ),
      expected: `fly.migrate.toml release_command is "true", expected "${EXPECTED_RELEASE_COMMAND}"`,
    });
  });

  test('fly.toml with the release_command commented out', () => {
    assert({
      given: `[deploy] with only a commented-out release_command`,
      should: 'report it missing rather than read the comment as the value',
      actual: findFlyReleaseCommandProblem(
        `[deploy]\n  # release_command = "${EXPECTED_RELEASE_COMMAND}"\n`,
      ),
      expected: 'fly.migrate.toml has no `release_command` under [deploy]',
    });
  });

  test('release_command present, but under a different table than [deploy]', () => {
    assert({
      given: `a correct-looking release_command under [other] instead of [deploy]`,
      should: 'report it missing under [deploy], ignoring the other table',
      actual: findFlyReleaseCommandProblem(
        `[deploy]\n[other]\n  release_command = "${EXPECTED_RELEASE_COMMAND}"\n`,
      ),
      expected: 'fly.migrate.toml has no `release_command` under [deploy]',
    });
  });

  test('fly.toml missing the [deploy] table entirely', () => {
    assert({
      given: 'a fly.toml with no [deploy] table at all',
      should: 'report the table missing',
      actual: findFlyReleaseCommandProblem('[env]\n  PORT = "8080"\n'),
      expected: 'fly.migrate.toml has no `[deploy]` table',
    });
  });
});

describe('verifyDeployConfig', () => {
  test('the real repository files together', () => {
    assert({
      given:
        'the committed Dockerfile, both fly configs, the deploy and auth-alerts workflows, .bun-version, start.ts, migrate.ts and the shutdown budget',
      should: 'report no problems',
      actual: verifyDeployConfig({
        dockerfile: realDockerfile,
        flyToml: realFlyToml,
        migratorToml: realMigratorToml,
        workflow: realWorkflow,
        probeWorkflow: realProbeWorkflow,
        readRepoFile,
        bunVersion: realBunVersion,
        startTs: realStart,
        migrateTs: realMigrate,
        shutdownBudgetTs: realShutdownBudget,
      }),
      expected: [],
    });
  });

  test('both files drifted at once', () => {
    assert({
      given: 'a wrong Bun version and a dropped release command',
      should: 'report both problems, not just the first',
      actual: verifyDeployConfig({
        dockerfile: 'FROM oven/bun:1.0.0-slim AS base\n',
        flyToml: realFlyToml,
        migratorToml: '[deploy]\n',
        workflow: realWorkflow,
        probeWorkflow: realProbeWorkflow,
        readRepoFile,
        bunVersion: '1.4.2',
        startTs: realStart,
        migrateTs: realMigrate,
        shutdownBudgetTs: realShutdownBudget,
      }).length,
      expected: 2,
    });
  });
});

describe('findFlyDatabaseSecretProblem', () => {
  test('the committed fly configs keep database credentials out of [env]', () => {
    assert({
      given: 'the real fly.migrate.toml',
      should: 'report no problem',
      actual: findFlyDatabaseSecretProblem(
        realMigratorToml,
        'fly.migrate.toml',
      ),
      expected: null,
    });
    assert({
      given: 'the real fly.toml',
      should: 'report no problem: both URLs are Fly secrets',
      actual: findFlyDatabaseSecretProblem(realFlyToml),
      expected: null,
    });
  });

  test('a database URL written into [env]', () => {
    assert({
      given:
        'fly.toml [env] setting MIGRATION_DATABASE_URL, with a commented DATABASE_URL beside it',
      should: 'report the uncommented credential only',
      actual: findFlyDatabaseSecretProblem(
        '[env]\n  # DATABASE_URL = "x"\n  MIGRATION_DATABASE_URL = "postgres://x"\n[http_service]\n',
      ),
      expected:
        'fly.toml [env] sets MIGRATION_DATABASE_URL; database credentials are Fly secrets',
    });
  });
});

describe('findMigrationCredentialProblem', () => {
  test('the committed runner reads the validated migration credential', () => {
    assert({
      given: 'the real migrate.ts',
      should: 'report no problem',
      actual: findMigrationCredentialProblem(realMigrate),
      expected: null,
    });
  });

  test('a runner that reads the runtime DATABASE_URL directly', () => {
    assert({
      given: 'the pre-ISSUE-39 runner reading process.env.DATABASE_URL',
      should: 'report that it bypasses the migration credential',
      actual: findMigrationCredentialProblem(
        'const url = process.env.DATABASE_URL;\nnew SQL(url);\n',
      ),
      expected:
        'migrate.ts does not read its credential through readMigrationConfig(process.env)',
    });
  });
});

describe('findWebReleaseCommandProblem (ISSUE-102)', () => {
  test('the committed web fly.toml runs no release command', () => {
    assert({
      given: 'the real fly.toml',
      should: 'report no problem',
      actual: findWebReleaseCommandProblem(realFlyToml),
      expected: null,
    });
  });

  test('a web fly.toml that migrates in its own release', () => {
    assert({
      given: `the pre-ISSUE-102 web [deploy] release_command`,
      should:
        'report it, because it would need the owner credential among the web secrets',
      actual: findWebReleaseCommandProblem(
        `[deploy]\n  # the old way\n  release_command = "${EXPECTED_RELEASE_COMMAND}"\n`,
      ),
      expected:
        'fly.toml runs a release_command; migrations run only from fly.migrate.toml, so the web app never holds the owner credential',
    });
  });
});

describe('findMigratorAppProblem (ISSUE-102)', () => {
  test('the committed migrator app serves nothing', () => {
    assert({
      given: 'the real fly.migrate.toml',
      should: 'report no problem',
      actual: findMigratorAppProblem(realMigratorToml),
      expected: null,
    });
  });

  test('a migrator app that would boot serving machines', () => {
    assert({
      given:
        'fly.migrate.toml with an [http_service], [[services]] or [processes]',
      should: 'report each, since its machines would hold the owner credential',
      actual: [
        '[http_service]\n  internal_port = 8080\n',
        '[[services]]\n',
        '[processes]\n  app = "bun start"\n',
        '# [http_service]\n',
      ].map(findMigratorAppProblem),
      expected: [
        'fly.migrate.toml defines [http_service]; the migrator app must have no services or processes',
        'fly.migrate.toml defines [[services]]; the migrator app must have no services or processes',
        'fly.migrate.toml defines [processes]; the migrator app must have no services or processes',
        null,
      ],
    });
  });
});

describe('findWorkflowMigrationOrderProblem (ISSUE-102)', () => {
  const migrate =
    '        run: >-\n          flyctl deploy -c fly.migrate.toml --remote-only --update-only\n';
  const web =
    '        run: >-\n          flyctl deploy -a offense-demo-staging --remote-only --ha=false\n';

  test('the committed workflow migrates before the web deploy', () => {
    assert({
      given: 'the real deploy-staging workflow',
      should: 'report no problem',
      actual: findWorkflowMigrationOrderProblem(realWorkflow),
      expected: null,
    });
  });

  test('a workflow that skips the migrator, deploys web first, or lets it create machines', () => {
    const problem =
      'deploy-staging.yml does not run `flyctl deploy -c fly.migrate.toml ... --update-only` before the web deploy';
    assert({
      given:
        'no migrator deploy, a migrator deploy after the web one, a commented migrator deploy, and one without --update-only',
      should: 'report each',
      actual: [
        web,
        web + migrate,
        '# flyctl deploy -c fly.migrate.toml --remote-only --update-only\n' +
          web,
        migrate.replace(' --update-only', '') + web,
      ].map(findWorkflowMigrationOrderProblem),
      expected: [problem, problem, problem, problem],
    });
  });
});

describe('findAlwaysOnProblem (ISSUE-175, DEC-40)', () => {
  const service = (lines: string) =>
    `[http_service]\n  internal_port = 8080\n${lines}\n\n  [[http_service.checks]]\n    grace_period = "10s"\n`;

  test('the committed fly.toml keeps staging always on', () => {
    assert({
      given: 'the real fly.toml',
      should: 'report no problem',
      actual: findAlwaysOnProblem(realFlyToml),
      expected: null,
    });
  });

  test('a service that may stop idle machines or keep none running', () => {
    assert({
      given:
        'auto-stop on, no machine kept running, a commented-out setting, and no [http_service]',
      should: 'report each as not always on',
      actual: [
        service('  auto_stop_machines = "stop"\n  min_machines_running = 1'),
        service('  auto_stop_machines = "off"\n  min_machines_running = 0'),
        service('  # auto_stop_machines = "off"\n  min_machines_running = 1'),
        '[env]\n  PORT = "8080"\n',
      ].map(findAlwaysOnProblem),
      expected: [
        'fly.toml [http_service] must set auto_stop_machines = "off" (DEC-40)',
        'fly.toml [http_service] must set min_machines_running = 1 (DEC-40)',
        'fly.toml [http_service] must set auto_stop_machines = "off" (DEC-40)',
        'fly.toml has no `[http_service]` table',
      ],
    });
  });
});

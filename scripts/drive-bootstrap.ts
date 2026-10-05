#!/usr/bin/env bun
/**
 * `bun drive:bootstrap [--dry-run] [--check] [--skip-webhooks] [--skip-key]
 * [--github] [--docs-workflows]`
 *
 * Provisions this repository's PageSpace drive from `drive-seed/manifest.json`
 * and records every id in `project.config.json`. Idempotent: it creates only
 * what is missing (verified against the live drive), seeds only pages it
 * created or finds empty, and writes each id back the moment it exists.
 *
 * Credential: PAGESPACE_BOOTSTRAP_TOKEN, an UNSCOPED key (drive creation and
 * webhooks refuse drive-scoped keys), minted by a human with
 * `pagespace keys create --all-drives --name <name>-bootstrap --show-token`.
 * The script never reads the CLI's credential store and never prints a secret.
 *
 * The agent key (`.env` and the GitHub PAGESPACE_TOKEN secret, used by CI and
 * the local `board:*` and `decision:record` commands) is minted through
 * `pagespace keys create` with the drive's custom "Agent" role, which the
 * script creates with drive-wide view and edit and no share: the built-in
 * MEMBER role is view-only on pages it did not create. `--check` asks
 * PageSpace whether that key can edit the Roadmap; a key that cannot is
 * re-minted on the next run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from './dotenv';
import {
  HttpError,
  checkReport,
  readOnly,
  validateSeed,
  type Paths,
  type Transport,
} from './drive-bootstrap-inspect';
import { inspectBootstrap } from './drive-bootstrap-access';
import { executePlan } from './drive-bootstrap-exec';
import {
  configuredId,
  parseManifest,
  unmappedSlots,
  type Manifest,
} from './drive-bootstrap-manifest';
import {
  formatPlan,
  planBootstrap,
  type BootstrapOptions,
  type ExistingState,
} from './drive-bootstrap-plan';
import { loadProjectConfig, type ProjectConfig } from './project-config';

type Flags = BootstrapOptions & {
  readonly dryRun: boolean;
  readonly check: boolean;
};

function parseFlags(argv: readonly string[]): Flags {
  const known = [
    '--dry-run',
    '--check',
    '--skip-webhooks',
    '--skip-key',
    '--github',
    '--docs-workflows',
  ];
  const unknown = argv.filter(
    (arg) => arg.startsWith('--') && !known.includes(arg),
  );
  if (unknown.length > 0)
    throw new Error(`Unknown flag(s): ${unknown.join(' ')}`);
  return {
    dryRun: argv.includes('--dry-run'),
    check: argv.includes('--check'),
    skipWebhooks: argv.includes('--skip-webhooks'),
    skipKey: argv.includes('--skip-key'),
    github: argv.includes('--github'),
    docsWorkflows: argv.includes('--docs-workflows'),
  };
}

/** What a dry run assumes without a credential: configured ids exist, unverified. */
function offlineState(
  config: ProjectConfig,
  manifest: Manifest,
  envText: string,
): ExistingState {
  const env = new Set(
    [...envText.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*\S/gm)].map(
      (match) => match[1],
    ),
  );
  const driveId = config.pagespace.driveId;
  const unknown = { workflows: new Set<string>(), agentKeyValid: null };
  if (driveId === null)
    return { drive: null, nodes: {}, env, agentRole: null, ...unknown };
  const nodes = Object.fromEntries(
    manifest.nodes.flatMap((node) => {
      const id = configuredId(config, node);
      return id ? [[node.ref, { id, empty: false, statuses: [] }]] : [];
    }),
  );
  return {
    drive: { id: driveId, drivePrompt: 'unverified', homePageId: null },
    nodes,
    env,
    agentRole: null,
    ...unknown,
  };
}

function liveTransport(
  apiUrl: string,
  token: string,
  tokenName = 'PAGESPACE_BOOTSTRAP_TOKEN',
): Transport {
  return {
    api: async <T>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (token === '') throw new Error(`${tokenName} is not set`);
      const response = await fetch(new URL(path, apiUrl), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
      });
      const text = await response.text();
      if (!response.ok) {
        const detail = (() => {
          try {
            return String(
              (JSON.parse(text) as { error?: unknown }).error ?? '',
            );
          } catch {
            return '';
          }
        })();
        throw new HttpError(
          response.status,
          `PageSpace ${method} ${path} → ${response.status}${detail ? `: ${detail}` : ''}`,
        );
      }
      return (text ? JSON.parse(text) : null) as T;
    },
    run: async (command, options) => {
      const child = Bun.spawn([...command], {
        stdin:
          options?.stdin === undefined
            ? 'inherit'
            : new TextEncoder().encode(options.stdin),
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout };
    },
    readText: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    writeText: (path, text) => writeFileSync(path, text),
    log: (line) => console.log(line),
  };
}

/** A read-only transport authenticated as `.env`'s agent key, when it has one. */
function agentKeyTransport(
  config: ProjectConfig,
  envText: string,
): Transport | null {
  const token = parseDotenv(envText).PAGESPACE_TOKEN ?? '';
  return token === ''
    ? null
    : readOnly(
        liveTransport(config.pagespace.apiUrl, token, 'PAGESPACE_TOKEN'),
      );
}

const TOKEN_HELP =
  'set PAGESPACE_BOOTSTRAP_TOKEN to an unscoped key (see the header of scripts/drive-bootstrap.ts)';

/** Seed files, placeholders and slot coverage, checked before any request. */
function preflight(
  config: ProjectConfig,
  manifest: Manifest,
  transport: Transport,
  seedDir: string,
): string[] {
  return [
    ...validateSeed(config, manifest, transport, seedDir),
    ...unmappedSlots(manifest).map(
      (slot) => `manifest maps no node to ${slot}`,
    ),
  ];
}

function planSource(config: ProjectConfig, live: boolean): string {
  if (live) return 'verified against the live drive';
  return config.pagespace.driveId === null
    ? 'offline: no drive provisioned yet'
    : 'offline: configured ids assumed present, unverified';
}

async function main(
  argv: readonly string[],
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const flags = parseFlags(argv);
  const config = loadProjectConfig(root);
  const paths: Paths = {
    config: join(root, 'project.config.json'),
    env: join(root, '.env'),
    agents: join(root, 'AGENTS.md'),
    seed: join(root, 'drive-seed'),
  };
  const manifest = parseManifest(
    JSON.parse(readFileSync(join(paths.seed, 'manifest.json'), 'utf8')),
  );
  const token = env.PAGESPACE_BOOTSTRAP_TOKEN ?? '';
  const live = token !== '';
  const base = liveTransport(config.pagespace.apiUrl, token);
  const transport = flags.dryRun || flags.check ? readOnly(base) : base;
  const problems = preflight(config, manifest, transport, paths.seed);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  if (!live && !flags.dryRun) {
    console.error(
      `This command reads the live drive: ${TOKEN_HELP}, or pass --dry-run.`,
    );
    return 2;
  }
  const envText = transport.readText(paths.env) ?? '';
  const inspected =
    live && config.pagespace.driveId !== null
      ? await inspectBootstrap(config, manifest, transport, {
          envText,
          withWorkflows: flags.docsWorkflows,
          agentKey: agentKeyTransport(config, envText),
        })
      : { state: offlineState(config, manifest, envText), problems: [] };
  if (flags.check) {
    console.log(checkReport(inspected.problems));
    return inspected.problems.length === 0 ? 0 : 1;
  }
  const actions = planBootstrap(config, manifest, inspected.state, flags);
  if (flags.dryRun) {
    console.log(
      `drive:bootstrap plan for "${config.pagespace.driveName}" (${planSource(config, live)}):`,
    );
    console.log(formatPlan(actions));
    console.log('Dry run: nothing was created, written or minted.');
    return 0;
  }
  await executePlan(actions, {
    manifest,
    transport,
    paths,
    state: inspected.state,
  });
  console.log(
    'drive:bootstrap done. Verify with `bun drive:bootstrap --check`.',
  );
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.cwd(), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `drive:bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(
        'Ids created so far are saved in project.config.json; rerun to resume.',
      );
      process.exit(1);
    },
  );
}

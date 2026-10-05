#!/usr/bin/env bun
/**
 * The main ruleset and repository settings as code.
 *
 *   bun github:rules            dry run: diff policy/github/repository.json
 *                               against live GitHub
 *   bun github:rules --apply    owner only: create or update the ruleset and
 *                               patch the settings, then diff again
 *
 * The desired state is rendered from two sources so neither duplicates the
 * other: project.config.json owns the repository slug, the owner and the
 * required check names (`gates.requiredChecks`, each pinned to GitHub
 * Actions), and policy/github/repository.json owns the settings, the
 * ruleset's shape and the review enforcement cutoff. The policy file must
 * not list required checks itself; `renderRepositoryConfig` refuses one that
 * does. The review-record check is always required and pinned to the
 * review-record GitHub App, whose id the owner stores as the Actions
 * variable REVIEW_RECORD_APP_ID (GRD-6.2). Agents never apply: the guard
 * refuses it and so does this script.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionIsAgent } from './agent-session';
import { loadProjectConfig, type ProjectConfig } from './project-config';

type Rule = {
  readonly type: string;
  readonly parameters?: {
    readonly required_status_checks?: readonly {
      readonly context: string;
      readonly integration_id: number | string;
    }[];
  } & Readonly<Record<string, unknown>>;
};
export type Ruleset = {
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly conditions: {
    readonly ref_name: {
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    };
  };
  readonly bypass_actors: readonly Readonly<Record<string, unknown>>[];
  readonly rules: readonly Rule[];
};
type Settings = Readonly<Record<string, boolean>>;
export type RepositoryConfig = {
  readonly repository: string;
  readonly owner: string;
  readonly settings: Settings;
  readonly ruleset: Ruleset;
};

/** policy/github/repository.json: everything but identity and check names. */
export type RepositoryPolicy = {
  readonly reviewEnforcementCutoff: string | null;
  readonly settings: Settings;
  readonly ruleset: Ruleset;
};

const APP_PLACEHOLDER = 'vars.REVIEW_RECORD_APP_ID';
/** The GitHub Actions app: the only legitimate source of CI check runs. */
export const GITHUB_ACTIONS_APP_ID = 15368;
export const REVIEW_RECORD_CHECK = 'review-record';

/**
 * The repository config to enforce: identity and required check names from
 * project.config.json, everything else from the committed policy.
 */
export function renderRepositoryConfig(
  policy: RepositoryPolicy,
  project: Pick<ProjectConfig, 'repo' | 'owner' | 'gates'>,
): RepositoryConfig {
  const checks = [
    ...project.gates.requiredChecks.map((context) => ({
      context,
      integration_id: GITHUB_ACTIONS_APP_ID,
    })),
    { context: REVIEW_RECORD_CHECK, integration_id: APP_PLACEHOLDER },
  ];
  return {
    repository: project.repo,
    owner: project.owner,
    settings: policy.settings,
    ruleset: {
      ...policy.ruleset,
      rules: policy.ruleset.rules.map((rule) => {
        if (rule.type !== 'required_status_checks') return rule;
        if (rule.parameters?.required_status_checks !== undefined)
          throw new Error(
            'policy/github/repository.json must not list required_status_checks; they come from project.config.json gates.requiredChecks',
          );
        return {
          ...rule,
          parameters: { ...rule.parameters, required_status_checks: checks },
        };
      }),
    },
  };
}

/** The committed ruleset with the review App id filled in. */
export function desiredRuleset(
  config: RepositoryConfig,
  appId: number,
): Ruleset {
  return {
    ...config.ruleset,
    rules: config.ruleset.rules.map((rule) =>
      rule.type === 'required_status_checks'
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: (
                rule.parameters?.required_status_checks ?? []
              ).map((check) =>
                check.integration_id === APP_PLACEHOLDER
                  ? { ...check, integration_id: appId }
                  : check,
              ),
            },
          }
        : rule,
    ),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const show = (value: unknown) => JSON.stringify(value);

/** Every leaf that differs between two JSON values, by path. */
export function diffValues(
  live: unknown,
  desired: unknown,
  path = '',
): string[] {
  const at = (key: string | number) =>
    typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
  if (Array.isArray(live) && Array.isArray(desired)) {
    const length = Math.max(live.length, desired.length);
    return Array.from({ length }, (_, index) =>
      index >= desired.length
        ? [`- ${at(index)}: ${show(live[index])}`]
        : index >= live.length
          ? [`+ ${at(index)}: ${show(desired[index])}`]
          : diffValues(live[index], desired[index], at(index)),
    ).flat();
  }
  if (isObject(live) && isObject(desired)) {
    const keys = [...new Set([...Object.keys(live), ...Object.keys(desired)])];
    return keys.flatMap((key) =>
      !(key in desired)
        ? [`- ${at(key)}: ${show(live[key])}`]
        : !(key in live)
          ? [`+ ${at(key)}: ${show(desired[key])}`]
          : diffValues(live[key], desired[key], at(key)),
    );
  }
  return show(live) === show(desired)
    ? []
    : [`~ ${path}: ${show(live)} → ${show(desired)}`];
}

/** Live values cut to the shape we manage; GitHub adds its own fields. */
function project(live: unknown, desired: unknown): unknown {
  if (Array.isArray(live) && Array.isArray(desired))
    return live.map((item, index) => project(item, desired[index]));
  if (isObject(live) && isObject(desired))
    return Object.fromEntries(
      Object.keys(desired)
        .filter((key) => key in live)
        .map((key) => [key, project(live[key], desired[key])]),
    );
  return live;
}

const byType = (rules: readonly Rule[]) =>
  [...rules].sort((a, b) => a.type.localeCompare(b.type));

export type LiveState = {
  readonly ruleset: (Ruleset & { readonly id: number }) | undefined;
  readonly settings: Settings;
};

export function planRules(input: {
  readonly config: RepositoryConfig;
  readonly appId: number;
  readonly live: LiveState;
}): {
  readonly changes: readonly string[];
  readonly actions: readonly string[];
} {
  const desired = desiredRuleset(input.config, input.appId);
  const rulesetChanges = input.live.ruleset
    ? diffValues(
        project(
          { ...input.live.ruleset, rules: byType(input.live.ruleset.rules) },
          {
            ...desired,
            rules: byType(desired.rules),
          },
        ),
        { ...desired, rules: byType(desired.rules) },
        'ruleset',
      )
    : [`+ ruleset ${desired.name}`];
  const settingsChanges = diffValues(
    project(input.live.settings, input.config.settings),
    input.config.settings,
    'settings',
  );
  return {
    changes: [...rulesetChanges, ...settingsChanges],
    actions: [
      ...(input.live.ruleset === undefined
        ? [`create ruleset ${desired.name}`]
        : rulesetChanges.length > 0
          ? [`update ruleset ${desired.name}`]
          : []),
      ...(settingsChanges.length > 0 ? ['patch settings'] : []),
    ],
  };
}

export function applyRefusal(input: {
  readonly autonomous: boolean;
  readonly login: string | undefined;
  readonly owner: string;
  readonly appId: number | undefined;
}): string | undefined {
  if (input.autonomous)
    return 'Agents never apply rulesets or settings (GRD-6.2 is human-only).';
  if (input.login !== input.owner)
    return `Only the owner (${input.owner}) applies; gh is authenticated as ${input.login ?? 'nobody'}.`;
  return input.appId === undefined
    ? 'Set the Actions variable REVIEW_RECORD_APP_ID to the review-record App id first (GRD-6.2).'
    : undefined;
}

// ------------------------------------------------------------------- edges

const root = resolve(import.meta.dir, '..');

function gh(args: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The failure message for a non-zero gh exit: the command, and gh's own reason when it gave one. */
export function ghFailure(args: readonly string[], stderr: string): string {
  const reason = stderr.trim();
  return reason
    ? `gh ${args.join(' ')} failed: ${reason}`
    : `gh ${args.join(' ')} failed`;
}

function ghJson<T>(args: readonly string[]): T {
  const result = gh(args);
  if (result.code !== 0) throw new Error(ghFailure(args, result.stderr));
  return JSON.parse(result.stdout) as T;
}

function readLive(config: RepositoryConfig) {
  const repo = `repos/${config.repository}`;
  const summary = ghJson<{ id: number; name: string }[]>([
    'api',
    `${repo}/rulesets`,
  ]).find((ruleset) => ruleset.name === config.ruleset.name);
  const variable = gh([
    'api',
    `${repo}/actions/variables/REVIEW_RECORD_APP_ID`,
    '--jq',
    '.value',
  ]);
  const appId = Number(variable.stdout.trim());
  return {
    appId: variable.code === 0 && Number.isInteger(appId) ? appId : undefined,
    live: {
      ruleset: summary
        ? ghJson<Ruleset & { id: number }>([
            'api',
            `${repo}/rulesets/${summary.id}`,
          ])
        : undefined,
      settings: ghJson<Settings>(['api', repo]),
    } satisfies LiveState,
  };
}

function apply(config: RepositoryConfig, appId: number, live: LiveState) {
  const repo = `repos/${config.repository}`;
  const file = join(tmpdir(), `github-rules-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(desiredRuleset(config, appId)));
  try {
    ghJson(
      live.ruleset
        ? [
            'api',
            '-X',
            'PUT',
            `${repo}/rulesets/${live.ruleset.id}`,
            '--input',
            file,
          ]
        : ['api', '-X', 'POST', `${repo}/rulesets`, '--input', file],
    );
  } finally {
    rmSync(file, { force: true });
  }
  ghJson([
    'api',
    '-X',
    'PATCH',
    repo,
    ...Object.entries(config.settings).flatMap(([key, value]) => [
      '-F',
      `${key}=${value}`,
    ]),
  ]);
}

function report(config: RepositoryConfig) {
  const { appId, live } = readLive(config);
  const plan = planRules({ config, appId: appId ?? 0, live });
  process.stdout.write(
    [
      `github:rules ${config.repository} (review-record App: ${appId ?? 'REVIEW_RECORD_APP_ID unset'})`,
      ...(plan.changes.length === 0
        ? ['  in sync']
        : plan.changes.map((c) => `  ${c}`)),
      '',
    ].join('\n'),
  );
  return { appId, live, plan };
}

if (import.meta.main) {
  const config = renderRepositoryConfig(
    (await Bun.file(
      join(root, 'policy/github/repository.json'),
    ).json()) as RepositoryPolicy,
    loadProjectConfig(root),
  );
  const { appId, live, plan } = report(config);
  if (process.argv.includes('--apply') && plan.actions.length > 0) {
    const refusal = applyRefusal({
      autonomous: sessionIsAgent(process.env),
      login: gh(['api', 'user', '--jq', '.login']).stdout.trim() || undefined,
      owner: config.owner,
      appId,
    });
    if (refusal) {
      process.stderr.write(`${refusal}\n`);
      process.exit(1);
    }
    apply(config, appId ?? 0, live);
    process.stdout.write(`applied: ${plan.actions.join(', ')}\n`);
    report(config);
  }
}

#!/usr/bin/env bun
/**
 * Which GitHub identity a session acts under. Autonomous agents
 * must act as the machine user from `.env.agent`; the owner's keyring token
 * and SSH key are the owner's alone. `assessAgentEnv` gates the pu launcher
 * and `assessGithubIdentity` is the `github-identity` check of bun doctor.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionIsAgent } from './agent-session';
import { parseDotenv } from './dotenv';

type Env = Readonly<Record<string, string | undefined>>;

function gitConfigEntries(env: Env): readonly (readonly [string, string])[] {
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  return Array.from({ length: Number.isInteger(count) ? count : 0 }, (_, i) => [
    (env[`GIT_CONFIG_KEY_${i}`] ?? '').toLowerCase(),
    env[`GIT_CONFIG_VALUE_${i}`] ?? '',
  ]);
}

/** Problems that would let an agent act as the owner; empty when safe. */
export function assessAgentEnv(env: Env): readonly string[] {
  const entries = gitConfigEntries(env);
  const has = (key: string, value: (v: string) => boolean) =>
    entries.some(([k, v]) => k === key && value(v));
  const helpers = entries.filter(
    ([key]) => key === 'credential.https://github.com.helper',
  );
  return [
    (env.GH_TOKEN ?? '') === ''
      ? 'GH_TOKEN is empty: gh and git would fall back to the owner keyring token'
      : undefined,
    sessionIsAgent(env) ? undefined : 'AGENT_AUTONOMOUS must be 1',
    has('url.https://github.com/.insteadof', (v) => v === 'git@github.com:')
      ? undefined
      : 'GIT_CONFIG_* must rewrite git@github.com: to HTTPS',
    helpers[0]?.[1] === '' && helpers.at(-1)?.[1] === '!gh auth git-credential'
      ? undefined
      : 'GIT_CONFIG_* must use `gh auth git-credential` as the GitHub credential helper',
    env.GIT_SSH_COMMAND === 'false'
      ? undefined
      : 'GIT_SSH_COMMAND must refuse SSH so the owner key is never used',
    ...identityKeys(env)
      .filter((key) => /[$`]/.test(env[key] ?? ''))
      .map(
        (key) =>
          `${key} must be a literal value; shell expansion is not allowed`,
      ),
  ].filter((problem): problem is string => problem !== undefined);
}

/** The keys of .env.agent the launcher exports; nothing else is passed on. */
function identityKeys(env: Env): readonly string[] {
  return Object.keys(env).filter((key) =>
    /^(?:GH_TOKEN|AGENT_AUTONOMOUS|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_\d+)$/.test(
      key,
    ),
  );
}

/**
 * Shell lines that export the validated identity values literally, so the
 * launcher never sources .env.agent (which would expand $VAR and $(…)).
 */
export function exportScript(env: Env): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return identityKeys(env)
    .map((key) => `export ${key}=${quote(env[key] ?? '')}`)
    .join('\n');
}

export type IdentityFacts = {
  readonly autonomous: boolean;
  /** The login gh authenticates as; undefined when gh cannot tell. */
  readonly login: string | undefined;
  readonly tokenFromEnv: boolean;
  readonly pushUrl: string | undefined;
  readonly credentialHelper: string | undefined;
  readonly owner: string;
};

export function assessGithubIdentity(facts: IdentityFacts): {
  readonly status: 'pass' | 'fail';
  readonly detail: string;
} {
  if (!facts.autonomous)
    return {
      status: 'pass',
      detail: `owner session as ${facts.login ?? 'an unknown GitHub identity'}`,
    };
  const problems = [
    facts.login === undefined ? 'gh cannot resolve the agent identity' : '',
    facts.login === facts.owner
      ? `AGENT_AUTONOMOUS=1 resolves to the owner ${facts.owner}`
      : '',
    facts.tokenFromEnv ? '' : 'GH_TOKEN is unset, so gh uses the owner keyring',
    facts.pushUrl?.startsWith('https://github.com/')
      ? ''
      : `origin pushes over ${facts.pushUrl ?? 'an unknown URL'}, not HTTPS`,
    facts.credentialHelper === '!gh auth git-credential'
      ? ''
      : 'git does not authenticate through `gh auth git-credential`',
  ].filter(Boolean);
  return problems.length > 0
    ? { status: 'fail', detail: problems.join('; ') }
    : {
        status: 'pass',
        detail: `autonomous as ${facts.login} (GH_TOKEN, HTTPS push)`,
      };
}

export type Regime = 'inactive' | 'owner' | 'agent' | 'misconfigured';

/**
 * Whether the identity regime is on, and what this session is under it. The
 * regime is on once the owner's .env.agent exists in the project root (pu's
 * PU_PROJECT_ROOT, the main checkout): an agent cannot switch it off by
 * deleting its worktree copy. A pu agent (PU_AGENT_ID) without GH_TOKEN or
 * AGENT_AUTONOMOUS=1 was resumed or started outside scripts/agent-launch.sh.
 */
export function identityRegime(
  env: Env,
  exists: (path: string) => boolean,
  mainCheckout?: string,
): Regime {
  const root = env.PU_PROJECT_ROOT ?? mainCheckout;
  if (!root || !exists(join(root, '.env.agent'))) return 'inactive';
  if (!env.PU_AGENT_ID) return 'owner';
  return env.GH_TOKEN && sessionIsAgent(env) ? 'agent' : 'misconfigured';
}

export function regimeCheck(
  regime: Regime,
  agentId: string | undefined,
): { readonly status: 'pass' | 'warn' | 'fail'; readonly detail: string } {
  if (regime === 'misconfigured')
    return {
      status: 'fail',
      detail: `pu agent ${agentId ?? '?'} runs without its machine identity: it was resumed (pu play, a daemon restart) or started outside scripts/agent-launch.sh; network git and gh are refused until it is restarted through the launcher`,
    };
  if (regime === 'inactive')
    return {
      status: 'warn',
      detail:
        'identity regime not active: pu agents act as the owner (GRD-6.2)',
    };
  return { status: 'pass', detail: `identity regime active (${regime})` };
}

if (import.meta.main) {
  const [mode, file] = process.argv.slice(2);
  if ((mode !== 'check-env' && mode !== 'export-env') || !file) {
    process.stderr.write(
      'usage: agent-identity.ts check-env|export-env <env file>\n',
    );
    process.exit(2);
  }
  const env = parseDotenv(readFileSync(file, 'utf8'));
  const problems = assessAgentEnv(env);
  for (const problem of problems)
    process.stderr.write(`agent-launch: ${problem}\n`);
  if (problems.length === 0 && mode === 'export-env')
    process.stdout.write(`${exportScript(env)}\n`);
  process.exit(problems.length > 0 ? 1 : 0);
}

/**
 * The one source of non-secret project identity and PageSpace drive layout
 * (`project.config.json`). Every script that names the repository, the
 * drive or a drive page reads it here; nothing hard-codes an id. Page and
 * channel ids are `null` until `bun drive:bootstrap` provisions the drive
 * and writes them back. Secrets (tokens, webhook URLs and secrets) never
 * live here: they stay in `.env` and GitHub secrets.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PAGE_KEYS = [
  'roadmap',
  'conventions',
  'issues',
  'bugs',
  'testCoverage',
  'agentTooling',
  'docDrift',
  'userFeedback',
  'backlog',
  'pendingDecisions',
  'plans',
  'prompts',
  'reviews',
  'library',
  'builderContract',
  'reviewerContract',
  'orchestratorLoop',
  'convergeLoop',
  'agentMemory',
  'agents',
  'documentation',
  'docsRunsSheet',
  'technicalDocs',
  'userDocs',
  'blog',
] as const;
export const CHANNEL_KEYS = [
  'standup',
  'incidents',
  'sprintRoom',
  'epicUpdates',
] as const;
export const AGENT_KEYS = [
  'scrumMaster',
  'builder',
  'reviewer',
  'documentation',
] as const;

export type PageKey = (typeof PAGE_KEYS)[number];
export type ChannelKey = (typeof CHANNEL_KEYS)[number];
export type AgentKey = (typeof AGENT_KEYS)[number];
type IdMap<K extends string> = Readonly<Record<K, string | null>>;

export type ProjectConfig = {
  readonly version: 1;
  readonly name: string;
  readonly displayName: string;
  readonly repo: string;
  readonly owner: string;
  readonly autonomyEnv: string;
  readonly gates: {
    readonly integrationCommand: string;
    readonly requiredChecks: readonly string[];
  };
  readonly pagespace: {
    readonly apiUrl: string;
    readonly driveName: string;
    readonly driveId: string | null;
    readonly pages: IdMap<PageKey>;
    readonly channels: IdMap<ChannelKey>;
    readonly agents: IdMap<AgentKey>;
  };
};

const SLUG = /^[a-z][a-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
// PageSpace ids are cuid2: 24 lowercase alphanumerics.
const PAGESPACE_ID = /^[a-z0-9]{24}$/;

const fail = (path: string, problem: string): never => {
  throw new Error(`project.config.json: ${path} ${problem}`);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, path: string, pattern?: RegExp): string => {
  if (typeof value !== 'string' || value.trim() === '')
    return fail(path, 'must be a non-empty string');
  if (pattern && !pattern.test(value))
    return fail(path, `must match ${pattern}`);
  return value;
};
const optionalId = (value: unknown, path: string): string | null =>
  value === null ? null : text(value, path, PAGESPACE_ID);
const idMap = <K extends string>(
  value: unknown,
  keys: readonly K[],
  path: string,
): IdMap<K> => {
  if (!isRecord(value)) return fail(path, 'must be an object');
  const unknownKey = Object.keys(value).find((key) => !keys.includes(key as K));
  if (unknownKey !== undefined)
    fail(`${path}.${unknownKey}`, 'is not a known key');
  return Object.fromEntries(
    keys.map((key) => [key, optionalId(value[key] ?? null, `${path}.${key}`)]),
  ) as IdMap<K>;
};

/** Validates parsed JSON into a config, failing closed on any malformed field. */
export function parseProjectConfig(raw: unknown): ProjectConfig {
  if (!isRecord(raw)) return fail('root', 'must be an object');
  if (raw.version !== 1) fail('version', 'must be 1');
  const gates = isRecord(raw.gates)
    ? raw.gates
    : fail('gates', 'must be an object');
  const pagespace = isRecord(raw.pagespace)
    ? raw.pagespace
    : fail('pagespace', 'must be an object');
  const checks = gates.requiredChecks;
  if (!Array.isArray(checks)) fail('gates.requiredChecks', 'must be an array');
  const apiUrl = text(pagespace.apiUrl, 'pagespace.apiUrl');
  if (!apiUrl.startsWith('https://')) fail('pagespace.apiUrl', 'must be https');
  return {
    version: 1,
    name: text(raw.name, 'name', SLUG),
    displayName: text(raw.displayName, 'displayName'),
    repo: text(raw.repo, 'repo', REPO),
    owner: text(raw.owner, 'owner'),
    autonomyEnv: text(raw.autonomyEnv, 'autonomyEnv', ENV_NAME),
    gates: {
      integrationCommand: text(
        gates.integrationCommand,
        'gates.integrationCommand',
      ),
      requiredChecks: (checks as unknown[]).map((check, index) =>
        text(check, `gates.requiredChecks[${index}]`),
      ),
    },
    pagespace: {
      apiUrl,
      driveName: text(pagespace.driveName, 'pagespace.driveName'),
      driveId: optionalId(pagespace.driveId ?? null, 'pagespace.driveId'),
      pages: idMap(pagespace.pages, PAGE_KEYS, 'pagespace.pages'),
      channels: idMap(pagespace.channels, CHANNEL_KEYS, 'pagespace.channels'),
      agents: idMap(pagespace.agents, AGENT_KEYS, 'pagespace.agents'),
    },
  };
}

const PROJECT_CONFIG_FILE = 'project.config.json';

/** Reads and validates `project.config.json` from the repository root. */
export function loadProjectConfig(root: string = process.cwd()): ProjectConfig {
  return parseProjectConfig(
    JSON.parse(readFileSync(join(root, PROJECT_CONFIG_FILE), 'utf8')),
  );
}

const notProvisioned = (what: string): never => {
  throw new Error(
    `${what} is not provisioned in project.config.json; run \`bun drive:bootstrap\``,
  );
};

/** The drive id, or a clear refusal when the drive has not been bootstrapped. */
export const requireDriveId = (config: ProjectConfig): string =>
  config.pagespace.driveId ?? notProvisioned('pagespace.driveId');

export const requirePage = (config: ProjectConfig, key: PageKey): string =>
  config.pagespace.pages[key] ?? notProvisioned(`pagespace.pages.${key}`);

export const requireChannel = (
  config: ProjectConfig,
  key: ChannelKey,
): string =>
  config.pagespace.channels[key] ?? notProvisioned(`pagespace.channels.${key}`);

export const requireAgent = (config: ProjectConfig, key: AgentKey): string =>
  config.pagespace.agents[key] ?? notProvisioned(`pagespace.agents.${key}`);

export const driveUrl = (config: ProjectConfig): string =>
  `${config.pagespace.apiUrl}/dashboard/${requireDriveId(config)}`;

export const repoUrl = (config: ProjectConfig): string =>
  `https://github.com/${config.repo}`;

/** True once `bun drive:bootstrap` has provisioned the project's drive. */
export const driveProvisioned = (config: ProjectConfig): boolean =>
  config.pagespace.driveId !== null;

/**
 * The notice a CI entrypoint prints when it skips drive work because no
 * drive exists yet (the template itself, or a project generated with
 * `--no-drive`). Once a drive is provisioned, a missing secret is a
 * misconfiguration and fails instead.
 */
export const driveSkipNotice = (what: string): string =>
  `::notice::${what} skipped: no PageSpace drive is provisioned (project.config.json pagespace.driveId is null; run \`bun drive:bootstrap\`)`;

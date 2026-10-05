/**
 * Pure planning for `bun drive:bootstrap`: given the config, the manifest and
 * what already exists in the drive, the ordered list of actions that brings
 * the drive to the manifest without touching anything that is already there.
 * Seeding (content, statuses, sheet headers, agent prompts) only targets
 * pages created in this run or found empty, so a rerun never clobbers edits.
 */
import {
  configuredId,
  type AgentSeed,
  type ConfigSlot,
  type DocsWorkflow,
  type Manifest,
  type ManifestNode,
  type NodeType,
  type StatusPreset,
} from './drive-bootstrap-manifest';
import { formatOf } from './drive-bootstrap-render';
import type { ProjectConfig } from './project-config';

export type NodeState = {
  readonly id: string;
  /** No seeded body yet: content, sheet cells or system prompt are blank. */
  readonly empty: boolean;
  /** Status slugs already configured, for task lists. */
  readonly statuses: readonly string[];
};

export type DriveState = {
  readonly id: string;
  readonly drivePrompt: string | null;
  readonly homePageId: string | null;
};

/** The drive's custom "Agent" role, as found: its id and drive-wide grant. */
export type RoleState = {
  readonly id: string;
  readonly view: boolean;
  readonly edit: boolean;
  readonly share: boolean;
};

/**
 * The drive role the agent key is minted with. The built-in MEMBER role is
 * view-only on pages it did not create, so a MEMBER key fails every board
 * write; this custom role grants view and edit drive-wide, never share.
 */
export const AGENT_ROLE = {
  name: 'Agent',
  description:
    'Agents and CI: read and edit pages and tasks; no sharing or deletion',
  view: true,
  edit: true,
  share: false,
} as const;

export const grantsAgentAccess = (role: RoleState): boolean =>
  role.view === AGENT_ROLE.view &&
  role.edit === AGENT_ROLE.edit &&
  role.share === AGENT_ROLE.share;

export type ExistingState = {
  readonly drive: DriveState | null;
  readonly nodes: Readonly<Record<string, NodeState>>;
  /** Env keys that already hold a value (names only, never values). */
  readonly env: ReadonlySet<string>;
  /** Names of scheduled workflows already in the drive. */
  readonly workflows: ReadonlySet<string>;
  /** The drive's "Agent" role, or null when it does not exist (or is unknown). */
  readonly agentRole: RoleState | null;
  /**
   * Whether `.env`'s PAGESPACE_TOKEN holds the Agent role and can edit the
   * Roadmap: false re-mints it, null means unverified (no token, or offline).
   */
  readonly agentKeyValid: boolean | null;
};

export type BootstrapOptions = {
  readonly skipWebhooks: boolean;
  readonly skipKey: boolean;
  readonly github: boolean;
  readonly docsWorkflows: boolean;
};

export type Action =
  | { readonly kind: 'createDrive'; readonly name: string }
  | {
      readonly kind: 'createPage';
      readonly ref: string;
      readonly title: string;
      readonly type: Exclude<NodeType, 'TASK'>;
      readonly parent: string | null;
      readonly slot: ConfigSlot | null;
      readonly contentMode?: 'html' | 'markdown';
    }
  | {
      readonly kind: 'createTask';
      readonly ref: string;
      readonly title: string;
      readonly parent: string;
      readonly slot: ConfigSlot | null;
    }
  | {
      readonly kind: 'recordId';
      readonly ref: string;
      readonly id: string;
      readonly slot: ConfigSlot;
    }
  | { readonly kind: 'keep'; readonly ref: string; readonly id: string }
  | {
      readonly kind: 'seedContent';
      readonly ref: string;
      readonly file: string;
    }
  | {
      readonly kind: 'createStatus';
      readonly ref: string;
      readonly slug: string;
      readonly preset: StatusPreset;
    }
  | {
      readonly kind: 'writeHeader';
      readonly ref: string;
      readonly header: readonly string[];
    }
  | {
      readonly kind: 'configureAgent';
      readonly ref: string;
      readonly agent: AgentSeed;
    }
  | { readonly kind: 'setDriveContext'; readonly file: string }
  | { readonly kind: 'setHomePage'; readonly ref: string }
  | {
      readonly kind: 'createWebhook';
      readonly ref: string;
      readonly envStem: string;
      readonly github: boolean;
    }
  /** roleId null creates the role; an id resets its drive-wide grant. */
  | { readonly kind: 'ensureAgentRole'; readonly roleId: string | null }
  | {
      readonly kind: 'mintKey';
      /** The PAGESPACE_TOKEN in .env exists but cannot edit: mint over it. */
      readonly replaces: boolean;
      readonly github: boolean;
    }
  | { readonly kind: 'createWorkflow'; readonly workflow: DocsWorkflow }
  | { readonly kind: 'renderAgentsMd' };

/** The slug PageSpace derives from a status name ("In Review" → in_review). */
export const statusSlug = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export const webhookEnv = (stem: string) =>
  ({
    url: `PAGESPACE_${stem}_WEBHOOK_URL`,
    secret: `PAGESPACE_${stem}_WEBHOOK_SECRET`,
  }) as const;

function structure(
  config: ProjectConfig,
  node: ManifestNode,
  found: NodeState | undefined,
): Action {
  if (found) {
    return node.config && configuredId(config, node) !== found.id
      ? { kind: 'recordId', ref: node.ref, id: found.id, slot: node.config }
      : { kind: 'keep', ref: node.ref, id: found.id };
  }
  if (node.type === 'TASK')
    return {
      kind: 'createTask',
      ref: node.ref,
      title: node.title,
      parent: node.parent ?? '',
      slot: node.config,
    };
  const contentMode =
    node.type === 'DOCUMENT' && node.content
      ? formatOf(node.content) === 'html'
        ? 'html'
        : 'markdown'
      : undefined;
  return {
    kind: 'createPage',
    ref: node.ref,
    title: node.title,
    type: node.type,
    parent: node.parent,
    slot: node.config,
    ...(contentMode ? { contentMode } : {}),
  };
}

function seeding(
  manifest: Manifest,
  node: ManifestNode,
  found: NodeState | undefined,
): Action[] {
  const blank = found === undefined || found.empty;
  const actions: Action[] = [];
  if (node.content && blank)
    actions.push({ kind: 'seedContent', ref: node.ref, file: node.content });
  for (const key of node.statuses) {
    const preset = manifest.statusPresets[key];
    const slug = statusSlug(preset.name);
    if (!found?.statuses.includes(slug))
      actions.push({ kind: 'createStatus', ref: node.ref, slug, preset });
  }
  if (node.header && blank)
    actions.push({ kind: 'writeHeader', ref: node.ref, header: node.header });
  if (node.agent && blank)
    actions.push({ kind: 'configureAgent', ref: node.ref, agent: node.agent });
  return actions;
}

function driveSettings(manifest: Manifest, state: ExistingState): Action[] {
  const actions: Action[] = [];
  if (!state.drive?.drivePrompt?.trim())
    actions.push({ kind: 'setDriveContext', file: manifest.driveContext });
  const home = state.nodes[manifest.homePage];
  if (!home || state.drive?.homePageId !== home.id)
    actions.push({ kind: 'setHomePage', ref: manifest.homePage });
  return actions;
}

/** The Agent role (created or reset), then a key minted with it when needed. */
function agentAccess(
  state: ExistingState,
  options: BootstrapOptions,
): Action[] {
  const actions: Action[] = [];
  const role = state.drive ? state.agentRole : null;
  if (role === null) actions.push({ kind: 'ensureAgentRole', roleId: null });
  else if (!grantsAgentAccess(role))
    actions.push({ kind: 'ensureAgentRole', roleId: role.id });
  const hasToken = !!state.drive && state.env.has('PAGESPACE_TOKEN');
  if (!options.skipKey && (!hasToken || state.agentKeyValid === false))
    actions.push({
      kind: 'mintKey',
      replaces: hasToken,
      github: options.github,
    });
  return actions;
}

function credentials(
  manifest: Manifest,
  state: ExistingState,
  options: BootstrapOptions,
): Action[] {
  const actions: Action[] = [];
  if (!options.skipWebhooks)
    for (const node of manifest.nodes) {
      if (!node.webhook) continue;
      const env = webhookEnv(node.webhook);
      const stale =
        !state.nodes[node.ref] ||
        !state.env.has(env.url) ||
        !state.env.has(env.secret);
      if (stale)
        actions.push({
          kind: 'createWebhook',
          ref: node.ref,
          envStem: node.webhook,
          github: options.github,
        });
    }
  actions.push(...agentAccess(state, options));
  if (options.docsWorkflows)
    for (const workflow of manifest.docsWorkflows)
      if (!state.drive || !state.workflows.has(workflow.name))
        actions.push({ kind: 'createWorkflow', workflow });
  return actions;
}

/**
 * The full, ordered action plan. Structure first (so every id exists before
 * any content mentions it), then seeding, drive settings, credentials, and
 * finally the AGENTS.md drive block.
 */
export function planBootstrap(
  config: ProjectConfig,
  manifest: Manifest,
  state: ExistingState,
  options: BootstrapOptions,
): Action[] {
  const actions: Action[] = state.drive
    ? []
    : [{ kind: 'createDrive', name: config.pagespace.driveName }];
  const nodes = state.drive ? state.nodes : {};
  const live: ExistingState = { ...state, nodes };
  actions.push(
    ...manifest.nodes.map((node) => structure(config, node, nodes[node.ref])),
  );
  for (const node of manifest.nodes)
    actions.push(...seeding(manifest, node, nodes[node.ref]));
  actions.push(
    ...driveSettings(manifest, live),
    ...credentials(manifest, live, options),
  );
  actions.push({ kind: 'renderAgentsMd' });
  return actions;
}

const slotName = (slot: ConfigSlot | null): string =>
  slot ? ` → ${slot.group}.${slot.key}` : '';

type Describers = {
  readonly [K in Action['kind']]: (
    action: Extract<Action, { kind: K }>,
  ) => string;
};

const DESCRIBE: Describers = {
  createDrive: (a) => `create drive "${a.name}" → pagespace.driveId`,
  createPage: (a) =>
    `create ${a.type} ${a.ref} "${a.title}" under ${a.parent ?? 'drive root'}${slotName(a.slot)}`,
  createTask: (a) =>
    `create task ${a.ref} "${a.title}" in ${a.parent}${slotName(a.slot)}`,
  recordId: (a) => `record existing ${a.ref} ${a.id}${slotName(a.slot)}`,
  keep: (a) => `keep ${a.ref} ${a.id}`,
  seedContent: (a) => `seed ${a.ref} from drive-seed/${a.file}`,
  createStatus: (a) => `add status ${a.slug} (${a.preset.group}) to ${a.ref}`,
  writeHeader: (a) =>
    `write header row (${a.header.length} columns) to ${a.ref}`,
  configureAgent: ({ ref, agent }) =>
    `configure agent ${ref}: ${agent.aiProvider}/${agent.aiModel}, ${agent.enabledTools.length} tools, prompt drive-seed/${agent.systemPrompt}`,
  setDriveContext: (a) => `set drive context from drive-seed/${a.file}`,
  setHomePage: (a) => `set drive home page to ${a.ref}`,
  createWebhook: (a) => {
    const env = webhookEnv(a.envStem);
    return `create incoming webhook on ${a.ref} → .env ${env.url}, ${env.secret}${a.github ? ' (+ GitHub secrets)' : ''}`;
  },
  ensureAgentRole: (a) =>
    a.roleId === null
      ? `create drive role "${AGENT_ROLE.name}" (drive-wide view and edit, no share)`
      : `reset drive role "${AGENT_ROLE.name}" ${a.roleId} to drive-wide view and edit, no share`,
  mintKey: (a) =>
    `mint drive-scoped key (role ${AGENT_ROLE.name}, browser consent) → .env PAGESPACE_TOKEN${a.replaces ? ', replacing a token that cannot edit' : ''}${a.github ? ' (+ GitHub secret)' : ''}`,
  createWorkflow: ({ workflow }) =>
    `create scheduled workflow "${workflow.name}" (${workflow.pipeline}, cron ${workflow.cron})`,
  renderAgentsMd: () =>
    'render the AGENTS.md drive block between <!-- drive:start --> and <!-- drive:end -->',
};

/** One human-readable line per action. Names env keys, never their values. */
export const describeAction = (action: Action): string =>
  (DESCRIBE[action.kind] as (action: Action) => string)(action);

/** The plan as printable text, keeps collapsed into a count. */
export function formatPlan(actions: readonly Action[]): string {
  const kept = actions.filter((action) => action.kind === 'keep').length;
  const lines = actions
    .filter((action) => action.kind !== 'keep')
    .map(
      (action, index) =>
        `${String(index + 1).padStart(3)}. ${describeAction(action)}`,
    );
  return [...lines, `${kept} existing node(s) kept unchanged.`].join('\n');
}

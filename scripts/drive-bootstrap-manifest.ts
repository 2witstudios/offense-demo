/**
 * The declarative drive layout `bun drive:bootstrap` provisions
 * (`drive-seed/manifest.json`). Each node names a stable `ref` (used by
 * `{{page:<ref>}}` placeholders in seed content), the `project.config.json`
 * slot its id is written to (`pages.roadmap`, `channels.standup`,
 * `agents.builder`) or `null` for structure the config does not track, and
 * what to seed into it. Pure: callers read the file.
 */
import {
  AGENT_KEYS,
  CHANNEL_KEYS,
  PAGE_KEYS,
  type ProjectConfig,
} from './project-config';

const NODE_TYPES = [
  'FOLDER',
  'DOCUMENT',
  'TASK_LIST',
  'TASK',
  'CHANNEL',
  'AI_CHAT',
  'SHEET',
  'CANVAS',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

type ConfigGroup = 'pages' | 'channels' | 'agents';
export type ConfigSlot = { readonly group: ConfigGroup; readonly key: string };

export type StatusPreset = {
  readonly name: string;
  readonly group: 'todo' | 'in_progress' | 'done';
  readonly color: string;
};

export type AgentSeed = {
  readonly systemPrompt: string;
  readonly enabledTools: readonly string[];
  readonly aiProvider: string;
  readonly aiModel: string;
};

export type ManifestNode = {
  readonly ref: string;
  readonly config: ConfigSlot | null;
  readonly title: string;
  readonly type: NodeType;
  readonly parent: string | null;
  readonly content?: string;
  readonly statuses: readonly string[];
  readonly header?: readonly string[];
  readonly agent?: AgentSeed;
  /** Env-name stem of a channel's incoming webhook, e.g. `SPRINT_ROOM`. */
  readonly webhook?: string;
};

export type DocsWorkflow = {
  readonly name: string;
  readonly pipeline: string;
  readonly cron: string;
};

export type Manifest = {
  readonly driveContext: string;
  readonly homePage: string;
  readonly statusPresets: Readonly<Record<string, StatusPreset>>;
  readonly nodes: readonly ManifestNode[];
  readonly docsWorkflows: readonly DocsWorkflow[];
};

const GROUP_KEYS: Readonly<Record<ConfigGroup, readonly string[]>> = {
  pages: PAGE_KEYS,
  channels: CHANNEL_KEYS,
  agents: AGENT_KEYS,
};

const fail = (path: string, problem: string): never => {
  throw new Error(`drive-seed/manifest.json: ${path} ${problem}`);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, path: string): string =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : fail(path, 'must be a non-empty string');
const optionalText = (value: unknown, path: string): string | undefined =>
  value === undefined ? undefined : text(value, path);
const texts = (value: unknown, path: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(path, 'must be an array');
  return value.map((item, index) => text(item, `${path}[${index}]`));
};

function parseSlot(value: unknown, path: string): ConfigSlot | null {
  if (value === null || value === undefined) return null;
  const [group, key, extra] = text(value, path).split('.');
  if (extra !== undefined || !(group in GROUP_KEYS))
    return fail(path, 'must be pages.<key>, channels.<key> or agents.<key>');
  if (!GROUP_KEYS[group as ConfigGroup].includes(key))
    return fail(path, `names no ${group} key in project.config.json`);
  return { group: group as ConfigGroup, key };
}

function parseAgent(value: unknown, path: string): AgentSeed | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail(path, 'must be an object');
  return {
    systemPrompt: text(value.systemPrompt, `${path}.systemPrompt`),
    enabledTools: texts(value.enabledTools, `${path}.enabledTools`),
    aiProvider: text(value.aiProvider, `${path}.aiProvider`),
    aiModel: text(value.aiModel, `${path}.aiModel`),
  };
}

function parseNode(raw: unknown, index: number): ManifestNode {
  const path = `nodes[${index}]`;
  if (!isRecord(raw)) return fail(path, 'must be an object');
  const type = text(raw.type, `${path}.type`);
  if (!NODE_TYPES.includes(type as NodeType))
    fail(`${path}.type`, `must be one of ${NODE_TYPES.join(', ')}`);
  const header =
    raw.header === undefined ? undefined : texts(raw.header, `${path}.header`);
  return {
    ref: text(raw.ref, `${path}.ref`),
    config: parseSlot(raw.config, `${path}.config`),
    title: text(raw.title, `${path}.title`),
    type: type as NodeType,
    parent: raw.parent === null ? null : text(raw.parent, `${path}.parent`),
    content: optionalText(raw.content, `${path}.content`),
    statuses: texts(raw.statuses, `${path}.statuses`),
    header,
    agent: parseAgent(raw.agent, `${path}.agent`),
    webhook: optionalText(raw.webhook, `${path}.webhook`),
  };
}

// Fields only one node type may carry.
const TYPED_FIELDS: readonly [keyof ManifestNode, NodeType][] = [
  ['agent', 'AI_CHAT'],
  ['webhook', 'CHANNEL'],
  ['header', 'SHEET'],
];

function checkNode(
  node: ManifestNode,
  seen: ReadonlyMap<string, ManifestNode>,
  presets: Record<string, unknown>,
): void {
  if (seen.has(node.ref)) fail(node.ref, 'is declared twice');
  if (node.parent !== null && !seen.has(node.parent))
    fail(
      node.ref,
      `has parent ${node.parent}, which must be declared before it`,
    );
  if (node.type === 'TASK' && seen.get(node.parent ?? '')?.type !== 'TASK_LIST')
    fail(node.ref, 'is a TASK, so its parent must be a TASK_LIST');
  for (const [field, type] of TYPED_FIELDS)
    if (node[field] !== undefined && node.type !== type)
      fail(node.ref, `has ${field} but is not a ${type}`);
  const unknown = node.statuses.find((status) => !(status in presets));
  if (unknown !== undefined)
    fail(node.ref, `uses unknown status preset ${unknown}`);
}

function checkGraph(
  nodes: readonly ManifestNode[],
  presets: Record<string, unknown>,
) {
  const seen = new Map<string, ManifestNode>();
  const slots = new Set<string>();
  for (const node of nodes) {
    checkNode(node, seen, presets);
    const slot = node.config ? `${node.config.group}.${node.config.key}` : null;
    if (slot !== null && slots.has(slot))
      fail(node.ref, `reuses config slot ${slot}`);
    if (slot !== null) slots.add(slot);
    seen.set(node.ref, node);
  }
}

/** Validates parsed manifest JSON, failing closed on any malformed node. */
export function parseManifest(raw: unknown): Manifest {
  if (!isRecord(raw)) return fail('root', 'must be an object');
  if (raw.version !== 1) fail('version', 'must be 1');
  const presetsRaw = isRecord(raw.statusPresets)
    ? raw.statusPresets
    : fail('statusPresets', 'must be an object');
  const statusPresets = Object.fromEntries(
    Object.entries(presetsRaw).map(([key, value]) => {
      const preset = isRecord(value)
        ? value
        : fail(`statusPresets.${key}`, 'must be an object');
      const group = text(preset.group, `statusPresets.${key}.group`);
      if (!['todo', 'in_progress', 'done'].includes(group))
        fail(`statusPresets.${key}.group`, 'must be todo, in_progress or done');
      return [
        key,
        {
          name: text(preset.name, `statusPresets.${key}.name`),
          group: group as StatusPreset['group'],
          color: text(preset.color, `statusPresets.${key}.color`),
        },
      ];
    }),
  );
  if (!Array.isArray(raw.nodes)) return fail('nodes', 'must be an array');
  const nodes = raw.nodes.map(parseNode);
  checkGraph(nodes, statusPresets);
  const homePage = text(raw.homePage, 'homePage');
  if (!nodes.some((node) => node.ref === homePage))
    fail('homePage', 'names no node');
  const workflows = Array.isArray(raw.docsWorkflows) ? raw.docsWorkflows : [];
  return {
    driveContext: text(raw.driveContext, 'driveContext'),
    homePage,
    statusPresets,
    nodes,
    docsWorkflows: workflows.map((item: unknown, index: number) => {
      const workflow = isRecord(item)
        ? item
        : fail(`docsWorkflows[${index}]`, 'must be an object');
      return {
        name: text(workflow.name, `docsWorkflows[${index}].name`),
        pipeline: text(workflow.pipeline, `docsWorkflows[${index}].pipeline`),
        cron: text(workflow.cron, `docsWorkflows[${index}].cron`),
      };
    }),
  };
}

/** The id `project.config.json` currently records for a node, if any. */
export const configuredId = (
  config: ProjectConfig,
  node: ManifestNode,
): string | null =>
  node.config
    ? ((
        config.pagespace[node.config.group] as Readonly<
          Record<string, string | null>
        >
      )[node.config.key] ?? null)
    : null;

/** Config slots the manifest leaves unprovisioned: a layout drift guard. */
export function unmappedSlots(manifest: Manifest): string[] {
  const mapped = new Set(
    manifest.nodes.flatMap((node) =>
      node.config ? [`${node.config.group}.${node.config.key}`] : [],
    ),
  );
  return (Object.keys(GROUP_KEYS) as ConfigGroup[])
    .flatMap((group) => GROUP_KEYS[group].map((key) => `${group}.${key}`))
    .filter((slot) => !mapped.has(slot));
}

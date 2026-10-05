/**
 * The read side of `bun drive:bootstrap`: the injected transport, live drive
 * inspection (what exists, what drifted) and seed validation. Inspection only
 * issues GETs, so `--check` and `--dry-run` run it through a read-only
 * transport.
 */
import { parseDotenv } from './dotenv';
import {
  configuredId,
  type Manifest,
  type ManifestNode,
} from './drive-bootstrap-manifest';
import { unknownPlaceholders } from './drive-bootstrap-render';
import type {
  DriveState,
  ExistingState,
  NodeState,
} from './drive-bootstrap-plan';
import type { ProjectConfig } from './project-config';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Transport = {
  readonly api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  readonly run: (
    command: readonly string[],
    options?: { readonly stdin?: string },
  ) => Promise<{ readonly code: number; readonly stdout: string }>;
  readonly readText: (path: string) => string | null;
  readonly writeText: (path: string, text: string) => void;
  readonly log: (line: string) => void;
};

export type Paths = {
  readonly config: string;
  readonly env: string;
  readonly agents: string;
  readonly seed: string;
};

/** A transport that refuses every write: what `--dry-run` and `--check` use. */
export const readOnly = (transport: Transport): Transport => ({
  ...transport,
  api: (method, path, body) =>
    method === 'GET'
      ? transport.api(method, path, body)
      : Promise.reject(new Error(`read-only: refused ${method} ${path}`)),
  run: (command) =>
    Promise.reject(new Error(`read-only: refused ${command[0]}`)),
  writeText: (path) => {
    throw new Error(`read-only: refused write to ${path}`);
  },
});

type PageRecord = {
  readonly id: string;
  readonly type: string;
  readonly driveId: string;
  readonly isTrashed: boolean;
  readonly content: string | null;
  readonly systemPrompt?: string | null;
};
type Listing = {
  readonly pages: readonly {
    id: string;
    title: string | null;
    type: string;
    isTaskLinked: boolean;
  }[];
};

export type Problem = { readonly ref: string; readonly message: string };

const pageType = (node: ManifestNode): string =>
  node.type === 'TASK' ? 'TASK_LIST' : node.type;

function isEmpty(node: ManifestNode, page: PageRecord): boolean {
  if (node.type === 'AI_CHAT') return !page.systemPrompt?.trim();
  if (node.type === 'SHEET')
    return !(page.content ?? '').includes('[sheets.cells.');
  if (node.type === 'FOLDER' || node.type === 'CHANNEL') return false;
  return !(page.content ?? '').trim();
}

async function getPage(
  transport: Transport,
  id: string,
): Promise<PageRecord | null> {
  try {
    return await transport.api<PageRecord>('GET', `/api/pages/${id}`);
  } catch (error) {
    if (error instanceof HttpError && [403, 404].includes(error.status))
      return null;
    throw error;
  }
}

async function nodeState(
  transport: Transport,
  node: ManifestNode,
  page: PageRecord,
): Promise<NodeState> {
  const statuses =
    pageType(node) === 'TASK_LIST'
      ? (
          await transport.api<{ statusConfigs: readonly { slug: string }[] }>(
            'GET',
            `/api/pages/${page.id}/tasks/statuses`,
          )
        ).statusConfigs.map((status) => status.slug)
      : [];
  return { id: page.id, empty: isEmpty(node, page), statuses };
}

function verify(
  node: ManifestNode,
  page: PageRecord | null,
  driveId: string,
): string | null {
  if (page === null) return 'not found (deleted, or not visible to this key)';
  if (page.driveId !== driveId)
    return `belongs to another drive (${page.driveId})`;
  if (page.isTrashed) return 'is in the trash';
  if (page.type !== pageType(node))
    return `is a ${page.type}, expected ${pageType(node)}`;
  return null;
}

export type Inspection = {
  readonly state: ExistingState;
  readonly problems: readonly Problem[];
};

/** Finds a node by title and type under its parent, cached per parent. */
async function findByTitle(
  transport: Transport,
  driveId: string,
  listings: Map<string, Listing>,
  node: ManifestNode,
  parentId: string | null,
): Promise<PageRecord | null> {
  const key = parentId ?? '';
  if (!listings.has(key)) {
    const query = parentId ? `&parentId=${parentId}` : '';
    listings.set(
      key,
      await transport.api<Listing>(
        'GET',
        `/api/drives/${driveId}/pages?ls=true${query}`,
      ),
    );
  }
  const match = listings
    .get(key)
    ?.pages.find(
      (page) =>
        page.title === node.title &&
        page.type === pageType(node) &&
        page.isTaskLinked === (node.type === 'TASK'),
    );
  return match ? getPage(transport, match.id) : null;
}

/** The node's page by configured id; a problem when that id is unusable. */
async function byConfiguredId(
  config: ProjectConfig,
  transport: Transport,
  node: ManifestNode,
  driveId: string,
): Promise<{ page: PageRecord | null; problem: string | null }> {
  const id = configuredId(config, node);
  if (id === null)
    return {
      page: null,
      problem: node.config
        ? `${node.config.group}.${node.config.key} is not provisioned`
        : null,
    };
  const page = await getPage(transport, id);
  const problem = verify(node, page, driveId);
  return problem === null
    ? { page, problem }
    : { page: null, problem: `${id} ${problem}` };
}

async function workflowNames(
  transport: Transport,
  driveId: string,
): Promise<Set<string>> {
  const raw = await transport.api<unknown>(
    'GET',
    `/api/workflows?driveId=${driveId}`,
  );
  const list = (
    Array.isArray(raw)
      ? raw
      : ((raw as { workflows?: unknown[] }).workflows ?? [])
  ) as { name: string }[];
  return new Set(list.map((item) => item.name));
}

const envKeys = (envText: string): Set<string> =>
  new Set(
    Object.entries(parseDotenv(envText)).flatMap(([key, value]) =>
      value ? [key] : [],
    ),
  );

export type InspectOptions = {
  readonly envText: string;
  readonly withWorkflows: boolean;
};

/**
 * Reads the live drive: the configured drive, each node by its configured
 * id (verified for drive, type and trash), else by title under its parent,
 * so a page created by a crashed run is adopted rather than duplicated.
 * The Agent role and key are left unverified: `inspectBootstrap` adds them.
 */
export async function inspectDrive(
  config: ProjectConfig,
  manifest: Manifest,
  transport: Transport,
  options: InspectOptions,
): Promise<Inspection> {
  const env = envKeys(options.envText);
  const none = (message: string): Inspection => ({
    state: {
      drive: null,
      nodes: {},
      env,
      workflows: new Set(),
      agentRole: null,
      agentKeyValid: null,
    },
    problems: [{ ref: 'drive', message }],
  });
  const driveId = config.pagespace.driveId;
  if (driveId === null) return none('pagespace.driveId is not provisioned');
  const drives = await transport.api<readonly DriveState[]>(
    'GET',
    '/api/drives',
  );
  const drive = drives.find((candidate) => candidate.id === driveId);
  if (!drive) return none(`drive ${driveId} not found or not accessible`);
  const problems: Problem[] = [];
  const nodes: Record<string, NodeState> = {};
  const listings = new Map<string, Listing>();
  for (const node of manifest.nodes) {
    const configured = await byConfiguredId(config, transport, node, driveId);
    if (configured.problem)
      problems.push({ ref: node.ref, message: configured.problem });
    const parentId = node.parent === null ? null : nodes[node.parent]?.id;
    const page =
      configured.page ??
      (parentId === undefined
        ? null
        : await findByTitle(transport, driveId, listings, node, parentId));
    if (page && verify(node, page, driveId) === null)
      nodes[node.ref] = await nodeState(transport, node, page);
  }
  const workflows = options.withWorkflows
    ? await workflowNames(transport, driveId)
    : new Set<string>();
  const { id, drivePrompt, homePageId } = drive;
  return {
    state: {
      drive: { id, drivePrompt, homePageId },
      nodes,
      env,
      workflows,
      agentRole: null,
      agentKeyValid: null,
    },
    problems,
  };
}

/** Every seed file exists and names only known variables and refs. */
export function validateSeed(
  config: ProjectConfig,
  manifest: Manifest,
  transport: Transport,
  seedDir: string,
): string[] {
  const vars = templateVars(config, null);
  const refs = new Set(manifest.nodes.map((node) => node.ref));
  const files = [
    manifest.driveContext,
    ...manifest.nodes.flatMap((node) =>
      [node.content, node.agent?.systemPrompt].filter(
        (file): file is string => !!file,
      ),
    ),
  ];
  return files.flatMap((file) => {
    const text = transport.readText(`${seedDir}/${file}`);
    if (text === null) return [`drive-seed/${file}: missing`];
    return unknownPlaceholders(text, { ...vars, driveId: '' }, refs).map(
      (token) => `drive-seed/${file}: unknown ${token}`,
    );
  });
}

export function templateVars(
  config: ProjectConfig,
  driveId: string | null,
): Record<string, string> {
  return {
    name: config.name,
    displayName: config.displayName,
    repo: config.repo,
    owner: config.owner,
    driveName: config.pagespace.driveName,
    apiUrl: config.pagespace.apiUrl,
    integrationCommand: config.gates.integrationCommand,
    ...(driveId ? { driveId } : {}),
  };
}

/** Configured ids that are null, missing, mistyped or trashed; role and key drift. */
export function checkReport(problems: readonly Problem[]): string {
  return problems.length === 0
    ? 'drive check: every configured id exists in the drive with the expected type, and PAGESPACE_TOKEN holds the Agent role and can edit.'
    : [
        'drive check FAILED:',
        ...problems.map((problem) => `  - ${problem.ref}: ${problem.message}`),
      ].join('\n');
}

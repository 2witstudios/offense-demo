// An in-memory PageSpace drive behind the bootstrap Transport, so the
// executor and inspector run end to end without a network. Seed files are
// read from the real drive-seed/ directory; everything else is virtual.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HttpError,
  type Paths,
  type Transport,
} from './drive-bootstrap-inspect';

const ROOT = join(import.meta.dir, '..');
export const paths: Paths = {
  config: '/virtual/project.config.json',
  env: '/virtual/.env',
  agents: '/virtual/AGENTS.md',
  seed: join(ROOT, 'drive-seed'),
};

type FakePage = {
  id: string;
  type: string;
  title: string;
  parentId: string | null;
  driveId: string;
  content: string | null;
  systemPrompt: string | null;
  isTrashed: boolean;
  isTaskLinked: boolean;
};

type Call = {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
};

const DEFAULT_SLUGS = ['pending', 'in_progress', 'blocked', 'completed'];

export function fakeDrive(options: { failOnCall?: number } = {}) {
  let counter = 0;
  const nextId = (prefix: string) =>
    `${prefix}${String((counter += 1)).padStart(24 - prefix.length, '0')}`;
  const drives: {
    id: string;
    name: string;
    drivePrompt: string | null;
    homePageId: string | null;
  }[] = [];
  const pages = new Map<string, FakePage>();
  const statuses = new Map<string, string[]>();
  const files = new Map<string, string>();
  const workflows: Record<string, unknown>[] = [];
  type Grant = { canView: boolean; canEdit: boolean; canShare: boolean };
  const roles: {
    id: string;
    driveId: string;
    name: string;
    driveWidePermissions: Grant | null;
  }[] = [];
  /** The role the minted PAGESPACE_TOKEN holds: a custom role id or 'member'. */
  const key: { role: string | null } = { role: null };
  const calls: Call[] = [];
  const logs: string[] = [];
  const commands: { command: readonly string[]; stdin?: string }[] = [];

  const page = (id: string): FakePage => {
    const found = pages.get(id);
    if (!found) throw new HttpError(404, `no page ${id}`);
    return found;
  };
  const addPage = (
    fields: Omit<FakePage, 'id' | 'content' | 'systemPrompt' | 'isTrashed'>,
  ): FakePage => {
    const created = {
      ...fields,
      id: nextId('p'),
      content: null,
      systemPrompt: null,
      isTrashed: false,
    };
    pages.set(created.id, created);
    return created;
  };

  // A custom role grants its drive-wide permissions; MEMBER is view-only on
  // pages it did not create, as PageSpace resolves it.
  const keyGrant = (): Grant =>
    roles.find((role) => role.id === key.role)?.driveWidePermissions ?? {
      canView: true,
      canEdit: false,
      canShare: false,
    };

  const routes: [
    string,
    RegExp,
    (match: RegExpExecArray, body: Record<string, unknown>) => unknown,
  ][] = [
    ['GET', /^\/api\/drives$/, () => drives],
    [
      'POST',
      /^\/api\/drives$/,
      (_, body) => {
        const drive = {
          id: nextId('d'),
          name: String(body.name),
          drivePrompt: null,
          homePageId: null,
        };
        drives.push(drive);
        return drive;
      },
    ],
    [
      'PATCH',
      /^\/api\/drives\/(\w+)$/,
      (match, body) =>
        Object.assign(drives.find((d) => d.id === match[1]) ?? {}, body),
    ],
    [
      'GET',
      /^\/api\/drives\/(\w+)\/pages\?ls=true(?:&parentId=(\w+))?$/,
      (match) => ({
        pages: [...pages.values()]
          .filter(
            (p) =>
              p.driveId === match[1] &&
              p.parentId === (match[2] ?? null) &&
              !p.isTrashed,
          )
          .map((p) => ({
            id: p.id,
            title: p.title,
            type: p.type,
            isTaskLinked: p.isTaskLinked,
            hasChildren: false,
          })),
      }),
    ],
    [
      'POST',
      /^\/api\/pages$/,
      (_, body) =>
        addPage({
          type: String(body.type),
          title: String(body.title),
          parentId: (body.parentId as string | null) ?? null,
          driveId: String(body.driveId),
          isTaskLinked: false,
        }),
    ],
    ['GET', /^\/api\/pages\/(\w+)$/, (match) => page(match[1])],
    [
      'PATCH',
      /^\/api\/pages\/(\w+)$/,
      (match, body) => Object.assign(page(match[1]), body),
    ],
    [
      'POST',
      /^\/api\/pages\/(\w+)\/tasks$/,
      (match, body) => {
        const list = page(match[1]);
        const linked = addPage({
          type: 'TASK_LIST',
          title: String(body.title),
          parentId: list.id,
          driveId: list.driveId,
          isTaskLinked: true,
        });
        return { id: nextId('t'), pageId: linked.id };
      },
    ],
    [
      'GET',
      /^\/api\/pages\/(\w+)\/tasks\/statuses$/,
      (match) => ({
        statusConfigs: [
          ...DEFAULT_SLUGS,
          ...(statuses.get(match[1]) ?? []),
        ].map((slug) => ({ slug })),
      }),
    ],
    [
      'POST',
      /^\/api\/pages\/(\w+)\/tasks\/statuses$/,
      (match, body) => {
        const slug = String(body.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_');
        const list = statuses.get(match[1]) ?? [];
        if (list.includes(slug)) throw new HttpError(409, 'exists');
        statuses.set(match[1], [...list, slug]);
        return { slug };
      },
    ],
    [
      'POST',
      /^\/api\/mcp\/sheets$/,
      (_, body) => {
        page(String(body.pageId)).content =
          '#%PAGESPACE_SHEETDOC v1\n[sheets.cells.A1]';
        return { cellsUpdated: (body.cells as unknown[]).length };
      },
    ],
    [
      'PUT',
      /^\/api\/ai\/page-agents\/(\w+)\/config$/,
      (match, body) =>
        Object.assign(page(match[1]), { systemPrompt: body.systemPrompt }),
    ],
    [
      'POST',
      /^\/api\/pages\/(\w+)\/webhooks$/,
      (match) => {
        page(match[1]);
        counter += 1;
        return {
          webhook: { webhookToken: `hook${counter}` },
          webhookSecret: `whsec-${counter}-do-not-print`,
        };
      },
    ],
    [
      'GET',
      /^\/api\/drives\/(\w+)\/roles$/,
      (match) => ({ roles: roles.filter((role) => role.driveId === match[1]) }),
    ],
    [
      'POST',
      /^\/api\/drives\/(\w+)\/roles$/,
      (match, body) => {
        if (roles.some((r) => r.driveId === match[1] && r.name === body.name))
          throw new HttpError(409, 'A role with this name already exists');
        const role = {
          id: nextId('r'),
          driveId: match[1],
          name: String(body.name),
          driveWidePermissions: (body.driveWidePermissions as Grant) ?? null,
        };
        roles.push(role);
        return { role };
      },
    ],
    [
      'PATCH',
      /^\/api\/drives\/(\w+)\/roles\/(\w+)$/,
      (match, body) => {
        const role = roles.find((r) => r.id === match[2]);
        if (!role) throw new HttpError(404, 'no role');
        return { role: Object.assign(role, body) };
      },
    ],
    [
      'GET',
      /^\/api\/auth\/key\?pageId=(\w+)$/,
      (match) => {
        if (key.role === null) throw new HttpError(401, 'no key');
        const driveId = page(match[1]).driveId;
        const custom = key.role === 'member' ? null : key.role;
        return {
          driveScopes: [{ id: driveId, customRoleId: custom }],
          page: { id: match[1], permissions: keyGrant() },
        };
      },
    ],
    [
      'GET',
      /^\/api\/workflows\?driveId=(\w+)$/,
      (match) => workflows.filter((w) => w.driveId === match[1]),
    ],
    [
      'POST',
      /^\/api\/workflows$/,
      (_, body) => {
        const workflow = { id: nextId('w'), ...body };
        workflows.push(workflow);
        return workflow;
      },
    ],
  ];

  const transport: Transport = {
    api: async <T>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> => {
      calls.push({ method, path, body });
      if (
        options.failOnCall !== undefined &&
        method !== 'GET' &&
        calls.filter((c) => c.method !== 'GET').length === options.failOnCall
      )
        throw new HttpError(500, `injected failure on ${method} ${path}`);
      for (const [verb, pattern, handler] of routes) {
        const match = verb === method ? pattern.exec(path) : null;
        if (match)
          return handler(match, (body ?? {}) as Record<string, unknown>) as T;
      }
      throw new HttpError(404, `no route ${method} ${path}`);
    },
    run: async (command, opts) => {
      commands.push({ command, stdin: opts?.stdin });
      if (command[1] !== 'keys') return { code: 0, stdout: '' };
      key.role = command[command.indexOf('--role') + 1] ?? null;
      return { code: 0, stdout: 'PAGESPACE_TOKEN=mcp_fakeTokenDoNotPrint\n' };
    },
    readText: (path) =>
      files.get(path) ??
      (path.startsWith(paths.seed) && existsSync(path)
        ? readFileSync(path, 'utf8')
        : null),
    writeText: (path, text) => void files.set(path, text),
    log: (line) => void logs.push(line),
  };
  return {
    transport,
    drives,
    pages,
    statuses,
    files,
    calls,
    logs,
    commands,
    roles,
    key,
  };
}

/** The committed config with every PageSpace id reset to null (the template state). */
export const templateConfigText = (): string =>
  readFileSync(join(ROOT, 'project.config.json'), 'utf8').replace(
    /"[a-z0-9]{24}"/g,
    'null',
  );
export const manifestJson = (): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'drive-seed', 'manifest.json'), 'utf8'));

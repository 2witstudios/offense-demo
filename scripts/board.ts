#!/usr/bin/env bun
/**
 * `bun board:*`: the common PageSpace board operations, committed so agents
 * stop rediscovering the pagespace CLI. Every command parses its
 * arguments purely (board-model.ts) and then drives the pagespace CLI
 * through an injected runner.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRelated,
  checkReplace,
  contentHash,
  findTask,
  issueListIds,
  leafBody,
  nextCodeNumber,
  parseBoardArgs,
  type BoardCommand,
} from './board-model';
import { sessionIsAgent } from './agent-session';
import { loadProjectConfig } from './project-config';

type Result = { readonly code: number; readonly stdout: string };

export type BoardDeps = {
  readonly pagespace: (args: readonly string[]) => Result;
  readonly readFile: (path: string) => string;
  /** The Issues root and bucket lists (`issueListIds`), read on demand. */
  readonly issueLists: () => readonly string[];
  /** AGENT_AUTONOMOUS=1: this session is an agent, not the owner. */
  readonly autonomous: boolean;
  /** A scratch path unique to this process and branch. */
  readonly scratch: (name: string) => string;
  readonly out: (text: string) => void;
};

class BoardError extends Error {}

function call(deps: BoardDeps, args: readonly string[]): string {
  const result = deps.pagespace(args);
  if (result.code !== 0)
    throw new BoardError(`pagespace ${args.slice(0, 2).join(' ')} failed`);
  return result.stdout;
}

const json = <T>(deps: BoardDeps, args: readonly string[]): T =>
  JSON.parse(call(deps, [...args, '--json'])) as T;

const pageContent = (deps: BoardDeps, pageId: string): string =>
  json<{ content?: string }>(deps, ['pages', 'read', pageId]).content ?? '';

const pageDetails = (deps: BoardDeps, pageId: string) =>
  json<{ title: string; parentId: string | null }>(deps, [
    'pages',
    'read-details',
    pageId,
  ]);

/**
 * Refuses when the page no longer hashes to what was read: the last check
 * before a write, since the server compares only the line count.
 */
function assertUnchanged(deps: BoardDeps, pageId: string, read: string) {
  if (contentHash(pageContent(deps, pageId)) !== contentHash(read))
    throw new BoardError(
      `${pageId} changed since it was read; nothing was written. Run the command again.`,
    );
}

/** Replaces the whole page, refusing if it changed since it was read. */
function writePage(
  deps: BoardDeps,
  pageId: string,
  before: string,
  after: string,
) {
  assertUnchanged(deps, pageId, before);
  const lines = before.split('\n').length;
  const file = deps.scratch(`${pageId}.html`);
  writeFileSync(file, after);
  try {
    call(deps, [
      'pages',
      'replace-lines',
      pageId,
      '--start',
      '1',
      '--end',
      String(lines),
      '--expect-lines',
      String(lines),
      '--file',
      file,
    ]);
  } finally {
    rmSync(file, { force: true });
  }
}

function setStatus(deps: BoardDeps, pageId: string, status: string) {
  const { parentId } = pageDetails(deps, pageId);
  if (!parentId) throw new BoardError(`${pageId} has no parent task list`);
  const task = findTask(json(deps, ['tasks', 'list', parentId]), pageId);
  if (!task) throw new BoardError(`${pageId} is not a task in ${parentId}`);
  if (!task.statuses.includes(status))
    throw new BoardError(
      `Unknown status "${status}"; this list has: ${task.statuses.join(', ')}`,
    );
  call(deps, ['tasks', 'update', parentId, task.taskId, '--status', status]);
  deps.out(`${pageId} → ${status}\n`);
}

function relate(
  deps: BoardDeps,
  pageId: string,
  label: string,
  target: string,
) {
  const before = pageContent(deps, pageId);
  const { title } = pageDetails(deps, target);
  writePage(
    deps,
    pageId,
    before,
    appendRelated(before, { label, id: target, title }),
  );
  deps.out(`${pageId}: Related pages += ${label}: ${title}\n`);
}

function create(
  deps: BoardDeps,
  command: Extract<BoardCommand, { command: 'create' }>,
) {
  const listTitles = (listId: string) =>
    json<{ tasks: { title: string; pageId: string }[] }>(deps, [
      'tasks',
      'list',
      listId,
    ]).tasks;
  // Issue numbers are global across the Issues buckets, wherever this lands.
  const numbered = (): { title: string }[] => {
    if (command.prefix !== 'ISSUE') return listTitles(command.listId);
    return deps.issueLists().flatMap(listTitles);
  };
  const titles = command.prefix ? numbered().map((task) => task.title) : [];
  const title = command.prefix
    ? `${command.prefix}-${nextCodeNumber(titles, command.prefix)} — ${command.title}`
    : command.title;
  const created = json<{ pageId?: string; page?: { id: string } }>(deps, [
    'tasks',
    'create',
    command.listId,
    '--title',
    title,
  ]);
  const pageId = created.pageId ?? created.page?.id;
  if (!pageId) throw new BoardError('pagespace did not return the task page');
  const related = command.related.map((ref) => ({
    ...ref,
    title: pageDetails(deps, ref.id).title,
  }));
  const before = pageContent(deps, pageId);
  writePage(
    deps,
    pageId,
    before,
    leafBody({ criteria: command.criteria, related }),
  );
  deps.out(`${pageId} ${title}\n`);
}

function replace(
  deps: BoardDeps,
  command: Extract<BoardCommand, { command: 'replace' }>,
) {
  const current = pageContent(deps, command.pageId);
  const refusal = checkReplace(current, {
    ...command,
    oldText: command.oldFile ? deps.readFile(command.oldFile) : undefined,
  });
  if (refusal) throw new BoardError(refusal);
  assertUnchanged(deps, command.pageId, current);
  call(deps, [
    'pages',
    'replace-lines',
    command.pageId,
    '--start',
    String(command.start),
    '--end',
    String(command.end),
    '--expect-lines',
    String(command.expectLines),
    '--file',
    command.file,
  ]);
  deps.out(
    `${command.pageId}: replaced lines ${command.start}-${command.end}\n`,
  );
}

export function runBoard(deps: BoardDeps, argv: readonly string[]): number {
  const parsed = parseBoardArgs(argv, deps.autonomous);
  if ('error' in parsed) {
    deps.out(`${parsed.error}\n`);
    return 2;
  }
  try {
    if (parsed.command === 'read')
      deps.out(call(deps, ['pages', 'read', parsed.pageId, '--raw']));
    if (parsed.command === 'hash')
      deps.out(`${contentHash(pageContent(deps, parsed.pageId))}\n`);
    if (parsed.command === 'status')
      setStatus(deps, parsed.pageId, parsed.status);
    if (parsed.command === 'relate')
      relate(deps, parsed.pageId, parsed.label, parsed.target);
    if (parsed.command === 'create') create(deps, parsed);
    if (parsed.command === 'replace') replace(deps, parsed);
    return 0;
  } catch (error) {
    if (!(error instanceof BoardError)) throw error;
    deps.out(`${error.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const branch =
    Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
      .stdout.toString()
      .trim()
      .replaceAll('/', '-') || 'detached';
  process.exitCode = runBoard(
    {
      pagespace: (args) => {
        const result = Bun.spawnSync(['pagespace', ...args], {
          stdout: 'pipe',
          stderr: 'inherit',
        });
        return { code: result.exitCode, stdout: result.stdout.toString() };
      },
      readFile: (path) => readFileSync(path, 'utf8'),
      issueLists: () => issueListIds(loadProjectConfig()),
      // A registered agent is an agent, as in the guard.
      autonomous: sessionIsAgent(process.env),
      scratch: (name) =>
        join(tmpdir(), `board-${branch}-${process.pid}-${name}`),
      out: (text) => process.stdout.write(text),
    },
    process.argv.slice(2),
  );
}

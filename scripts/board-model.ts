/**
 * Pure argument handling and page edits for the `bun board:*` commands
 * (board.ts runs them against the pagespace CLI). Page text is edited as
 * raw lines, never stripped of markup, so placeholders such as
 * `room:&lt;id&gt;:presence` survive.
 */
import { createHash } from 'node:crypto';
import {
  requirePage,
  type PageKey,
  type ProjectConfig,
} from './project-config';

type RelatedRef = { readonly label: string; readonly id: string };
export type RelatedEntry = RelatedRef & { readonly title: string };

export type BoardCommand =
  | { readonly command: 'read'; readonly pageId: string }
  | { readonly command: 'hash'; readonly pageId: string }
  | {
      readonly command: 'status';
      readonly pageId: string;
      readonly status: string;
    }
  | {
      readonly command: 'relate';
      readonly pageId: string;
      readonly label: string;
      readonly target: string;
    }
  | {
      readonly command: 'create';
      readonly listId: string;
      /** Auto-number the title with this code prefix, e.g. ISSUE or DEC. */
      readonly prefix: string | undefined;
      readonly title: string;
      readonly criteria: readonly string[];
      readonly related: readonly RelatedRef[];
    }
  | {
      readonly command: 'replace';
      readonly pageId: string;
      readonly start: number;
      readonly end: number;
      readonly expectLines: number;
      readonly file: string;
      readonly oldFile: string | undefined;
      readonly expectHash: string | undefined;
    };

const BOARD_USAGE = [
  'bun board:read <pageId>',
  'bun board:hash <pageId>',
  'bun board:status <taskPageId> <status-slug>',
  'bun board:relate <pageId> <Label> <targetPageId>',
  'bun board:create <taskListPageId> [--issue | --prefix <CODE>] --title "<Given X, should Y>" [--criterion "<Given A, should B>"]... [--related Label=<pageId>]...',
  'bun board:replace <pageId> --start N --end M --expect-lines L --file <new.html> (--expect-hash <board:hash> | --old-file <old.html>)',
].join('\n');

const PAGE_ID = /^[a-z0-9]{20,32}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * SHA3-256 of a page's content: the concurrency guard, since the server
 * checks only the line count and an edit can keep it.
 */
export const contentHash = (text: string): string =>
  createHash('sha3-256').update(text).digest('hex');
const SLUG = /^[a-z][a-z0-9_-]*$/;

type Parsed = BoardCommand | { readonly error: string };

const fail = (error: string): Parsed => ({ error: `${error}\n${BOARD_USAGE}` });

type Flags = {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
  readonly switches: ReadonlySet<string>;
};

/**
 * Reads `--flag value`, `--flag=value` and switches, refusing an unknown
 * flag, a flag without its value and more positional arguments than the
 * command takes, so nothing the caller typed is silently dropped.
 */
function flagValues(
  args: readonly string[],
  known: {
    readonly values: readonly string[];
    readonly switches: readonly string[];
    /** Value flags that may be given more than once. */
    readonly repeatable?: readonly string[];
  },
): Flags | { readonly error: string } {
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const at = arg.indexOf('=');
    const flag = arg.startsWith('--') && at !== -1 ? arg.slice(0, at) : arg;
    if (known.switches.includes(arg)) switches.add(arg);
    else if (known.values.includes(flag)) {
      const value = flag === arg ? args[++index] : arg.slice(at + 1);
      if (value === undefined || value.startsWith('--'))
        return { error: `${flag} needs a value` };
      if (values.has(flag) && !known.repeatable?.includes(flag))
        return { error: `${flag} given twice` };
      values.set(flag, [...(values.get(flag) ?? []), value]);
    } else if (arg.startsWith('--')) return { error: `Unknown flag ${flag}` };
    else if (positional.length > 0)
      return { error: `Unexpected argument ${arg}` };
    else positional.push(arg);
  }
  return { values, positional, switches };
}

const CREATE_FLAGS = {
  values: ['--title', '--criterion', '--related', '--prefix'],
  switches: ['--issue'],
  repeatable: ['--criterion', '--related'],
};
const REPLACE_FLAGS = {
  values: [
    '--start',
    '--end',
    '--expect-lines',
    '--file',
    '--old-file',
    '--expect-hash',
  ],
  switches: [],
};

function parseRelated(entries: readonly string[]): RelatedRef[] | undefined {
  const refs = entries.map((entry) => {
    const at = entry.indexOf('=');
    return { label: entry.slice(0, at), id: entry.slice(at + 1) };
  });
  return refs.every((ref) => ref.label !== '' && PAGE_ID.test(ref.id))
    ? refs
    : undefined;
}

function parseCreate(args: readonly string[]): Parsed {
  const flags = flagValues(args, CREATE_FLAGS);
  if ('error' in flags) return fail(flags.error);
  const { values, positional, switches } = flags;
  const [listId] = positional;
  const title = values.get('--title')?.[0] ?? '';
  const related = parseRelated(values.get('--related') ?? []);
  if (!PAGE_ID.test(listId ?? '')) return fail('create needs a task list id');
  if (title.trim() === '') return fail('create needs --title');
  if (!related) return fail('--related takes Label=<pageId>');
  const prefix = values.get('--prefix')?.[0];
  if (prefix !== undefined && !/^[A-Z]{2,6}$/.test(prefix))
    return fail('--prefix takes 2-6 capital letters');
  return {
    command: 'create',
    listId,
    prefix: switches.has('--issue') ? 'ISSUE' : values.get('--prefix')?.[0],
    title: title.trim(),
    criteria: values.get('--criterion') ?? [],
    related,
  };
}

function parseReplace(args: readonly string[]): Parsed {
  const flags = flagValues(args, REPLACE_FLAGS);
  if ('error' in flags) return fail(flags.error);
  const { values, positional } = flags;
  // Decimal only: Number('0x1') would read hex as 1.
  const number = (flag: string) => {
    const value = values.get(flag)?.[0] ?? '';
    return /^\d+$/.test(value) ? Number(value) : Number.NaN;
  };
  const [pageId] = positional;
  const [start, end, expectLines] = [
    number('--start'),
    number('--end'),
    number('--expect-lines'),
  ];
  const file = values.get('--file')?.[0];
  const expectHash = values.get('--expect-hash')?.[0];
  const oldFile = values.get('--old-file')?.[0];
  // The line count alone cannot tell a same-length edit from the caller's read.
  if (expectHash === undefined && oldFile === undefined)
    return fail(
      'replace needs --expect-hash (from bun board:hash) or --old-file (the lines as you read them)',
    );
  const valid =
    PAGE_ID.test(pageId ?? '') &&
    (expectHash === undefined || HASH.test(expectHash)) &&
    [start, end, expectLines].every(Number.isInteger) &&
    start >= 1 &&
    end >= start &&
    file !== undefined;
  return valid
    ? {
        command: 'replace',
        pageId,
        start,
        end,
        expectLines,
        file,
        oldFile,
        expectHash,
      }
    : fail(
        'replace needs a page id, --start, --end, --expect-lines and --file',
      );
}

const pageCommands: Readonly<
  Record<
    string,
    (pageId: string, rest: readonly string[]) => Parsed | undefined
  >
> = {
  read: (pageId, rest) =>
    rest.length === 0 ? { command: 'read', pageId } : undefined,
  hash: (pageId, rest) =>
    rest.length === 0 ? { command: 'hash', pageId } : undefined,
  status: (pageId, [status = '', ...extra]) =>
    SLUG.test(status) && extra.length === 0
      ? { command: 'status', pageId, status }
      : undefined,
  relate: (pageId, [label = '', target = '']) =>
    label !== '' && PAGE_ID.test(target)
      ? { command: 'relate', pageId, label, target }
      : undefined,
};

/** Done is granted from an independent review record, never by the agent. */
const DONE = 'completed';

export function parseBoardArgs(
  argv: readonly string[],
  autonomous = false,
): Parsed {
  const [command = '', first = '', ...rest] = argv;
  if (autonomous && command === 'status' && rest[0] === DONE)
    return fail(
      "A registered agent (a builder or reviewer started by pu, or any AGENT_AUTONOMOUS session) never marks a task Done: Done is granted from an independent review record, by the owner or the owner's own orchestrator session, which has a PU_AGENT_ID but no registration.",
    );
  if (command === 'create') return parseCreate(argv.slice(1));
  if (command === 'replace') return parseReplace(argv.slice(1));
  const parsed = PAGE_ID.test(first)
    ? pageCommands[command]?.(first, rest)
    : undefined;
  return (
    parsed ?? fail(`Unknown or malformed board command: ${argv.join(' ')}`)
  );
}

export function findTask(
  list: {
    readonly tasks: readonly { readonly id: string; readonly pageId: string }[];
    readonly availableStatuses: readonly { readonly slug: string }[];
  },
  pageId: string,
):
  | { readonly taskId: string; readonly statuses: readonly string[] }
  | undefined {
  const task = list.tasks.find((candidate) => candidate.pageId === pageId);
  return (
    task && {
      taskId: task.id,
      statuses: list.availableStatuses.map((status) => status.slug),
    }
  );
}

/**
 * The bucket lists nested in the drive-root `Issues` list
 * (`project.config.json` `pagespace.pages`). Issue numbers span every
 * bucket, so numbering reads all of them.
 */
const ISSUE_BUCKET_KEYS = [
  'bugs',
  'testCoverage',
  'agentTooling',
  'docDrift',
  'userFeedback',
  'backlog',
  'pendingDecisions',
] as const satisfies readonly PageKey[];

/** The Issues root list, then every provisioned bucket list. */
export function issueListIds(config: ProjectConfig): readonly string[] {
  return [
    requirePage(config, 'issues'),
    ...ISSUE_BUCKET_KEYS.map((key) => config.pagespace.pages[key]).filter(
      (id): id is string => id !== null,
    ),
  ];
}

/** One more than the highest `<PREFIX>-n` title; 1 for an empty list. */
export function nextCodeNumber(
  titles: readonly string[],
  prefix: string,
): number {
  const pattern = new RegExp(`^${prefix}-(\\d+)\\b`);
  const numbers = titles
    .map((title) => pattern.exec(title)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return Math.max(0, ...numbers) + 1;
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const relatedItem = (entry: RelatedEntry): string =>
  [
    '<li>',
    `${escapeHtml(entry.label)}: <a class="mention" data-mention-type="page" data-page-id="${entry.id}">@${escapeHtml(entry.title)}</a>`,
    '</li>',
  ].join('\n');

const RELATED_HEADING = '<h3>\nRelated pages\n</h3>';

export function leafBody(input: {
  readonly criteria: readonly string[];
  readonly related: readonly RelatedEntry[];
}): string {
  const criteria = input.criteria.flatMap((criterion) => [
    '<li>',
    escapeHtml(criterion),
    '</li>',
  ]);
  return [
    '<ul>',
    ...criteria,
    '</ul>',
    RELATED_HEADING,
    '<ul>',
    ...input.related.map(relatedItem),
    '</ul>',
  ].join('\n');
}

export function appendRelated(html: string, entry: RelatedEntry): string {
  const heading = html.lastIndexOf(RELATED_HEADING);
  const close =
    heading === -1
      ? -1
      : html.indexOf('</ul>', heading + RELATED_HEADING.length);
  if (close === -1)
    return `${html}\n${RELATED_HEADING}\n<ul>\n${relatedItem(entry)}\n</ul>`;
  return `${html.slice(0, close)}${relatedItem(entry)}\n${html.slice(close)}`;
}

/** Undefined when the replace is safe to send; otherwise why not. */
export function checkReplace(
  current: string,
  input: {
    readonly start: number;
    readonly end: number;
    readonly expectLines: number;
    readonly oldText?: string;
    readonly expectHash?: string;
  },
): string | undefined {
  if (
    input.expectHash !== undefined &&
    contentHash(current) !== input.expectHash
  )
    return 'The page changed since you read it (content hash differs). Read it again.';
  const lines = current.split('\n');
  if (lines.length !== input.expectLines)
    return `The page has ${lines.length} lines, not ${input.expectLines}: someone edited it. Read it again.`;
  if (input.end > lines.length)
    return `Lines ${input.start}-${input.end} are outside the page (${lines.length} lines).`;
  const old = lines.slice(input.start - 1, input.end).join('\n');
  const trim = (text: string) => text.replace(/\n$/, '');
  return input.oldText !== undefined && trim(old) !== trim(input.oldText)
    ? `Lines ${input.start}-${input.end} changed since you read them. Read the page again.`
    : undefined;
}

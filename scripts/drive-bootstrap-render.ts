/**
 * Pure text transforms behind `bun drive:bootstrap`: seed placeholder
 * resolution, the targeted id write-back into `project.config.json`, the
 * `.env` merge, and the AGENTS.md drive block. Nothing here reads or writes
 * a file; the executor does.
 */
import type { ConfigSlot } from './drive-bootstrap-manifest';

export type RenderFormat = 'html' | 'markdown' | 'text';

type PageRef = { readonly id: string | null; readonly title: string };

export type RenderContext = {
  readonly vars: Readonly<Record<string, string>>;
  readonly driveId: string | null;
  readonly pages: Readonly<Record<string, PageRef>>;
};

const PLACEHOLDER =
  /\{\{\s*(?:(page|pageId|pageUrl):)?([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The render format a seed file is written in, from its extension. */
export const formatOf = (file: string): RenderFormat =>
  file.endsWith('.html') ? 'html' : file.endsWith('.md') ? 'markdown' : 'text';

function mention(ref: PageRef, id: string, format: RenderFormat): string {
  if (format === 'html')
    return `<a class="mention" data-mention-type="page" data-page-id="${id}">@${escapeHtml(ref.title)}</a>`;
  if (format === 'markdown') return `@[${ref.title}](${id}:page)`;
  return `"${ref.title}" (${id})`;
}

/** Every placeholder in a seed text that names no variable or page ref. */
export function unknownPlaceholders(
  text: string,
  vars: Readonly<Record<string, string>>,
  refs: ReadonlySet<string>,
): string[] {
  const unknown = new Set<string>();
  for (const [token, kind, name] of text.matchAll(PLACEHOLDER)) {
    const known = kind ? refs.has(name) : name in vars;
    if (!known) unknown.add(token);
  }
  return [...unknown];
}

/**
 * Resolves `{{var}}`, `{{page:ref}}` (a mention in the file's own format),
 * `{{pageId:ref}}` and `{{pageUrl:ref}}`. Throws on an unknown name or a ref
 * that has no id yet, so seed content never ships with a dangling token.
 */
export function resolvePlaceholders(
  text: string,
  context: RenderContext,
  format: RenderFormat,
): string {
  const problems: string[] = [];
  const out = text.replace(
    PLACEHOLDER,
    (token, kind: string | undefined, name: string) => {
      if (!kind) {
        if (name in context.vars) return context.vars[name];
        problems.push(`${token}: no such variable`);
        return token;
      }
      const ref = context.pages[name];
      if (!ref) {
        problems.push(`${token}: no such page ref`);
        return token;
      }
      if (ref.id === null || (kind === 'pageUrl' && context.driveId === null)) {
        problems.push(`${token}: not created yet`);
        return token;
      }
      if (kind === 'pageId') return ref.id;
      if (kind === 'pageUrl') return `/dashboard/${context.driveId}/${ref.id}`;
      return mention(ref, ref.id, format);
    },
  );
  if (problems.length > 0)
    throw new Error(`Unresolved seed placeholders: ${problems.join('; ')}`);
  return out;
}

/**
 * Writes one id into `project.config.json` text without reformatting the
 * rest of the file: only the `"<key>": null|"<id>"` value inside the named
 * group changes. `drive` targets `pagespace.driveId`.
 */
export function setConfigId(
  text: string,
  slot: ConfigSlot | 'drive',
  id: string,
): string {
  if (!/^[a-z0-9]{24}$/.test(id))
    throw new Error(`Refusing to record malformed id ${JSON.stringify(id)}`);
  const value = /("driveId"\s*:\s*)(null|"[^"]*")/;
  if (slot === 'drive') {
    if (!value.test(text))
      throw new Error('project.config.json has no pagespace.driveId');
    return text.replace(value, `$1"${id}"`);
  }
  const open = text.search(new RegExp(`"${slot.group}"\\s*:\\s*\\{`));
  if (open === -1)
    throw new Error(`project.config.json has no pagespace.${slot.group}`);
  const close = text.indexOf('}', open);
  const block = text.slice(open, close);
  const field = new RegExp(`("${slot.key}"\\s*:\\s*)(null|"[^"]*")`);
  if (!field.test(block))
    throw new Error(
      `project.config.json has no pagespace.${slot.group}.${slot.key}`,
    );
  return (
    text.slice(0, open) + block.replace(field, `$1"${id}"`) + text.slice(close)
  );
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const envValue = (value: string): string =>
  /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;

/**
 * Sets `updates` in a dotenv text: an existing assignment of the same key is
 * replaced in place, new keys are appended, and every other line (comments,
 * unrelated keys) is kept byte for byte. Returns only key names alongside the
 * text so callers can report what changed without echoing a secret.
 */
export function mergeEnv(
  text: string,
  updates: Readonly<Record<string, string>>,
): { readonly text: string; readonly keys: readonly string[] } {
  for (const [key, value] of Object.entries(updates))
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value))
      throw new Error(
        `Refusing to write env key ${key}: malformed name or multi-line value`,
      );
  const pending = new Map(Object.entries(updates));
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const merged = lines.flatMap((line) => {
    const key = ENV_LINE.exec(line)?.[1];
    if (key === undefined || !Object.hasOwn(updates, key)) return [line];
    if (!pending.has(key)) return []; // a duplicate assignment of a key already rewritten
    pending.delete(key);
    return [`${key}=${envValue(updates[key])}`];
  });
  for (const [key, value] of pending) merged.push(`${key}=${envValue(value)}`);
  return { text: `${merged.join('\n')}\n`, keys: Object.keys(updates) };
}

const AGENTS_DRIVE_START = '<!-- drive:start -->';
const AGENTS_DRIVE_END = '<!-- drive:end -->';

export type DriveLine = {
  readonly driveName: string;
  readonly driveId: string | null;
  readonly conventionsId: string | null;
};

/**
 * The AGENTS.md "Work management" drive line the skills read to find the
 * drive and its conventions page.
 */
function driveParagraph(line: DriveLine): string {
  if (line.driveId === null)
    return 'Drive: not provisioned yet — run `bun drive:bootstrap`';
  const conventions =
    line.conventionsId === null
      ? ''
      : ` · conventions page "Task artifacts and linking" (\`${line.conventionsId}\`)`;
  return `Drive: "${line.driveName}" (\`${line.driveId}\`)${conventions}`;
}

/**
 * Replaces the text between the drive markers in AGENTS.md. Text without
 * both markers (in order) comes back unchanged with `found: false`.
 */
export function renderAgentsDrive(
  text: string,
  line: DriveLine,
): { readonly text: string; readonly found: boolean } {
  const start = text.indexOf(AGENTS_DRIVE_START);
  const end = text.indexOf(AGENTS_DRIVE_END);
  if (start === -1 || end === -1 || end < start) return { text, found: false };
  const before = text.slice(0, start + AGENTS_DRIVE_START.length);
  return {
    text: `${before}\n\n${driveParagraph(line)}\n${text.slice(end)}`,
    found: true,
  };
}

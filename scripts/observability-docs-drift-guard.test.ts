import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { eventRegistry, loggableFields } from '@offense-demo/logger';

setupRitewayBun();

/**
 * `docs/operations/observability.md` hand-copies `@offense-demo/logger`'s event
 * registry into a markdown table; the audit found it 4 events stale. This
 * guard parses that table and fails the moment it and the registry diverge
 * in either direction (missing event, extra event, or wrong severity),
 * instead of relying on someone remembering to update the doc.
 */
const repoRoot = path.resolve(import.meta.dir, '..');
const docPath = path.join(repoRoot, 'docs/operations/observability.md');

type Severity = 'info' | 'warn' | 'error';

function parseEventTable(markdown: string): Record<string, Severity> {
  const section = markdown.split('## Event registry')[1]?.split('\n## ')[0];
  if (!section)
    throw new Error('observability.md: no "Event registry" section');
  const rows: Record<string, Severity> = {};
  for (const line of section.split('\n')) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*(info|warn|error)\s*\|/);
    if (!match) continue;
    const [, event, severity] = match;
    if (event in rows)
      throw new Error(`observability.md: duplicate event row "${event}"`);
    rows[event] = severity as Severity;
  }
  return rows;
}

describe('observability docs drift guard', () => {
  test('docs/operations/observability.md matches @offense-demo/logger eventRegistry exactly', async () => {
    const markdown = await readFile(docPath, 'utf8');
    const documented = parseEventTable(markdown);
    assert({
      given: 'the event table hand-copied into observability.md',
      should:
        'list exactly the event names and severities in @offense-demo/logger',
      actual: documented,
      expected: eventRegistry,
    });
  });

  test('the parser itself extracts rows, not a silent empty pass', () => {
    const fixture = [
      '## Event registry',
      '',
      '| Event | Severity | Meaning |',
      '| --- | --- | --- |',
      '| `example.one` | info | does a thing |',
      '| `example.two` | error | fails at a thing |',
      '',
      '## Rules',
      '',
      'not a table row',
    ].join('\n');
    assert({
      given: 'a markdown fixture with an Event registry table',
      should: 'parse each row into an event/severity map',
      actual: parseEventTable(fixture),
      expected: { 'example.one': 'info', 'example.two': 'error' },
    });
  });

  test('a duplicate event row fails the parse instead of silently keeping the last severity', () => {
    const fixture = [
      '## Event registry',
      '',
      '| Event | Severity | Meaning |',
      '| --- | --- | --- |',
      '| `example.one` | info | does a thing |',
      '| `example.one` | info | the same event, listed twice |',
      '',
      '## Rules',
    ].join('\n');
    expect(() => parseEventTable(fixture)).toThrow(
      'observability.md: duplicate event row "example.one"',
    );
  });
});

describe('ADR 0019 loggable fields drift guard', () => {
  test('the ADR table matches @offense-demo/logger loggableFields exactly', async () => {
    const markdown = await readFile(
      path.join(repoRoot, 'docs/decisions/0019-token-secret-ownership.md'),
      'utf8',
    );
    const section = markdown.split('## Loggable fields')[1] ?? '';
    const documented = Object.fromEntries(
      section
        .split('\n')
        .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map(([, field, kind]) => [field, kind]),
    );
    assert({
      given: 'the loggable-field table in ADR 0019',
      should: 'list exactly the fields and kinds the logger admits',
      actual: documented,
      expected: loggableFields,
    });
  });
});

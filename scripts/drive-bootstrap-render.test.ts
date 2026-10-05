import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  mergeEnv,
  renderAgentsDrive,
  resolvePlaceholders,
  setConfigId,
  unknownPlaceholders,
  type RenderContext,
} from './drive-bootstrap-render';
import { parseProjectConfig } from './project-config';
import { templateConfigText } from './drive-bootstrap-fake.test-support';

setupRitewayBun();

const ID = 'abcdefghijklmnopqrstuvwx';
const context: RenderContext = {
  vars: { displayName: 'Offense Demo', repo: 'owner/offense-demo' },
  driveId: 'driveidxxxxxxxxxxxxxxxxx',
  pages: {
    conventions: { id: ID, title: 'Task artifacts & linking' },
    later: { id: null, title: 'Not yet' },
  },
};
const errorOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('resolvePlaceholders', () => {
  test('variables and page references in each format', () => {
    assert({
      given: 'an html seed with a variable and a page mention',
      should: 'render the editor mention element with an escaped title',
      actual: resolvePlaceholders(
        '<p>{{displayName}} {{page:conventions}}</p>',
        context,
        'html',
      ),
      expected: `<p>Offense Demo <a class="mention" data-mention-type="page" data-page-id="${ID}">@Task artifacts &amp; linking</a></p>`,
    });
    assert({
      given: 'a markdown seed with a page mention',
      should: 'render the markdown mention syntax',
      actual: resolvePlaceholders(
        'See {{ page:conventions }}.',
        context,
        'markdown',
      ),
      expected: `See @[Task artifacts & linking](${ID}:page).`,
    });
    assert({
      given: 'an agent prompt (text) with a page mention, id and url',
      should:
        'render a quoted title with id, the raw id and the dashboard path',
      actual: resolvePlaceholders(
        '{{page:conventions}} {{pageId:conventions}} {{pageUrl:conventions}}',
        context,
        'text',
      ),
      expected: `"Task artifacts & linking" (${ID}) ${ID} /dashboard/driveidxxxxxxxxxxxxxxxxx/${ID}`,
    });
  });

  test('dangling tokens fail loudly', () => {
    assert({
      given: 'an unknown variable, an unknown ref and a ref without an id',
      should: 'refuse, naming every unresolved token',
      actual: errorOf(() =>
        resolvePlaceholders(
          '{{nope}} {{page:ghost}} {{page:later}}',
          context,
          'html',
        ),
      ),
      expected:
        'Unresolved seed placeholders: {{nope}}: no such variable; {{page:ghost}}: no such page ref; {{page:later}}: not created yet',
    });
    assert({
      given: 'a seed text checked before any page exists',
      should: 'list only the tokens that name nothing',
      actual: unknownPlaceholders(
        '{{repo}} {{page:conventions}} {{page:ghost}} {{bad}}',
        context.vars,
        new Set(['conventions']),
      ),
      expected: ['{{page:ghost}}', '{{bad}}'],
    });
  });
});

describe('setConfigId', () => {
  test('writes one id in place', () => {
    const text = templateConfigText();
    const updated = setConfigId(
      setConfigId(text, { group: 'agents', key: 'documentation' }, ID),
      'drive',
      'drive0000000000000000000',
    );
    const config = parseProjectConfig(JSON.parse(updated));
    assert({
      given: 'agents.documentation, a key that also exists under pages',
      should: 'set only the agents slot and the drive id',
      actual: [
        config.pagespace.agents.documentation,
        config.pagespace.pages.documentation,
        config.pagespace.driveId,
      ],
      expected: [ID, null, 'drive0000000000000000000'],
    });
    assert({
      given: 'the rewritten file',
      should: 'differ from the original only on the two changed lines',
      actual: updated
        .split('\n')
        .filter((line, index) => line !== text.split('\n')[index]).length,
      expected: 2,
    });
    assert({
      given: 'a malformed id',
      should: 'refuse to record it',
      actual: errorOf(() => setConfigId(text, 'drive', 'Not-An-Id')),
      expected: 'Refusing to record malformed id "Not-An-Id"',
    });
  });
});

describe('mergeEnv', () => {
  test('never clobbers unrelated keys', () => {
    const before =
      '# local stack\nDATABASE_URL=postgres://x\nexport PAGESPACE_TOKEN=old\nOTHER="keep me"\n';
    const merged = mergeEnv(before, {
      PAGESPACE_TOKEN: 'mcp_new',
      PAGESPACE_STANDUP_WEBHOOK_URL: 'https://pagespace.ai/api/webhooks/t',
    });
    assert({
      given: 'an env file with comments, unrelated keys and an old token',
      should:
        'replace the token in place, keep everything else, and append new keys',
      actual: merged.text,
      expected:
        '# local stack\nDATABASE_URL=postgres://x\nPAGESPACE_TOKEN=mcp_new\nOTHER="keep me"\nPAGESPACE_STANDUP_WEBHOOK_URL=https://pagespace.ai/api/webhooks/t\n',
    });
    assert({
      given: 'the merge report',
      should: 'name the keys and never carry a value',
      actual: [merged.keys, JSON.stringify(merged.keys).includes('mcp_new')],
      expected: [['PAGESPACE_TOKEN', 'PAGESPACE_STANDUP_WEBHOOK_URL'], false],
    });
  });

  test('edge cases', () => {
    assert({
      given: 'an empty env file and a value with a space',
      should: 'write a quoted assignment',
      actual: mergeEnv('', { A_B: 'x y' }).text,
      expected: 'A_B="x y"\n',
    });
    assert({
      given: 'a multi-line value',
      should: 'refuse it rather than corrupt the file',
      actual: errorOf(() => mergeEnv('', { SECRET: 'a\nb' })),
      expected:
        'Refusing to write env key SECRET: malformed name or multi-line value',
    });
  });
});

describe('renderAgentsDrive', () => {
  const doc =
    '## Work management\n\n<!-- drive:start -->\nold line\n<!-- drive:end -->\n\nRest.\n';

  test('replaces only the marked block', () => {
    const rendered = renderAgentsDrive(doc, {
      driveName: 'Offense Demo',
      driveId: 'drive0000000000000000000',
      conventionsId: ID,
    });
    assert({
      given: 'AGENTS.md with drive markers and a provisioned drive',
      should:
        'render the drive name, drive id and conventions page id between the markers',
      actual: rendered.text,
      expected: `## Work management\n\n<!-- drive:start -->\n\nDrive: "Offense Demo" (\`drive0000000000000000000\`) · conventions page "Task artifacts and linking" (\`${ID}\`)\n<!-- drive:end -->\n\nRest.\n`,
    });
    assert({
      given: 'a second render of the rendered text',
      should: 'be a no-op',
      actual: renderAgentsDrive(rendered.text, {
        driveName: 'Offense Demo',
        driveId: 'drive0000000000000000000',
        conventionsId: ID,
      }).text,
      expected: rendered.text,
    });
  });

  test('unprovisioned and unmarked documents', () => {
    assert({
      given: 'no drive id yet',
      should: 'point at bun drive:bootstrap instead of an id',
      actual: renderAgentsDrive(doc, {
        driveName: 'Offense Demo',
        driveId: null,
        conventionsId: null,
      }).text.includes(
        '\nDrive: not provisioned yet — run `bun drive:bootstrap`\n',
      ),
      expected: true,
    });
    assert({
      given: 'a document without the markers',
      should: 'come back unchanged and report the markers missing',
      actual: renderAgentsDrive('no markers\n', {
        driveName: 'Offense Demo',
        driveId: null,
        conventionsId: null,
      }),
      expected: { text: 'no markers\n', found: false },
    });
  });
});

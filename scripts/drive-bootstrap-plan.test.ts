import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { parseManifest, unmappedSlots } from './drive-bootstrap-manifest';
import {
  describeAction,
  formatPlan,
  planBootstrap,
  statusSlug,
  type BootstrapOptions,
  type ExistingState,
  type NodeState,
} from './drive-bootstrap-plan';
import { setConfigId } from './drive-bootstrap-render';
import { parseProjectConfig } from './project-config';
import {
  manifestJson,
  templateConfigText,
} from './drive-bootstrap-fake.test-support';

setupRitewayBun();

const manifest = parseManifest(manifestJson());
const config = parseProjectConfig(JSON.parse(templateConfigText()));
const options: BootstrapOptions = {
  skipWebhooks: false,
  skipKey: false,
  github: false,
  docsWorkflows: false,
};
const empty: ExistingState = {
  drive: null,
  nodes: {},
  env: new Set(),
  workflows: new Set(),
  agentRole: null,
  agentKeyValid: null,
};
const AGENT_ROLE_ID = 'role00000000000000000000';
const id = (n: number) => `n${String(n).padStart(23, '0')}`;
const ALL_ENV = new Set([
  'PAGESPACE_TOKEN',
  ...['STANDUP', 'SPRINT_ROOM', 'EPIC_UPDATES', 'INCIDENTS'].flatMap((s) => [
    `PAGESPACE_${s}_WEBHOOK_URL`,
    `PAGESPACE_${s}_WEBHOOK_SECRET`,
  ]),
]);
const fullNodes = (): Record<string, NodeState> =>
  Object.fromEntries(
    manifest.nodes.map((node, index) => [
      node.ref,
      {
        id: id(index),
        empty: false,
        statuses: node.statuses.map((key) =>
          statusSlug(manifest.statusPresets[key].name),
        ),
      },
    ]),
  );
const provisioned: ExistingState = {
  drive: {
    id: 'drive0000000000000000000',
    drivePrompt: 'context',
    homePageId: id(0),
  },
  nodes: fullNodes(),
  env: ALL_ENV,
  workflows: new Set(),
  agentRole: { id: AGENT_ROLE_ID, view: true, edit: true, share: false },
  agentKeyValid: true,
};
const provisionedConfig = parseProjectConfig(
  JSON.parse(
    manifest.nodes.reduce(
      (text, node, index) =>
        node.config ? setConfigId(text, node.config, id(index)) : text,
      setConfigId(templateConfigText(), 'drive', 'drive0000000000000000000'),
    ),
  ),
);
const kinds = (actions: { kind: string }[]) =>
  actions.map((action) => action.kind);

describe('the committed manifest', () => {
  test('covers the config layout', () => {
    assert({
      given: 'drive-seed/manifest.json and project.config.json',
      should: 'map a node to every page, channel and agent slot',
      actual: unmappedSlots(manifest),
      expected: [],
    });
  });
});

describe('planBootstrap on an empty template', () => {
  const actions = planBootstrap(config, manifest, empty, options);

  test('creates everything in a safe order', () => {
    assert({
      given: 'a config with every id null',
      should: 'create the drive first and render AGENTS.md last',
      actual: [actions[0].kind, actions.at(-1)?.kind],
      expected: ['createDrive', 'renderAgentsMd'],
    });
    assert({
      given: 'the full plan',
      should: 'create one node per manifest entry and keep none',
      actual: [
        actions.filter(
          (a) => a.kind === 'createPage' || a.kind === 'createTask',
        ).length,
        actions.filter((a) => a.kind === 'keep').length,
      ],
      expected: [manifest.nodes.length, 0],
    });
    const lastCreate = actions.findLastIndex(
      (a) => a.kind === 'createPage' || a.kind === 'createTask',
    );
    const firstSeed = actions.findIndex((a) => a.kind === 'seedContent');
    assert({
      given: 'cross-page mentions in seed content',
      should: 'finish every create before the first content seed',
      actual: lastCreate < firstSeed,
      expected: true,
    });
    assert({
      given: 'the Issues buckets',
      should:
        'create them as tasks of the Issues list, so each is a task-linked list',
      actual: actions
        .filter((a) => a.kind === 'createTask')
        .map((a) => ('ref' in a ? a.ref : '')),
      expected: [
        'bugs',
        'testCoverage',
        'agentTooling',
        'docDrift',
        'userFeedback',
        'backlog',
        'pendingDecisions',
      ],
    });
    assert({
      given: 'the Pending decisions list',
      should: 'add the Confirmed and Overruled done statuses and Merged',
      actual: actions.flatMap((a) =>
        a.kind === 'createStatus' && a.ref === 'pendingDecisions'
          ? [`${a.slug}:${a.preset.group}`]
          : [],
      ),
      expected: ['confirmed:done', 'overruled:done', 'merged:in_progress'],
    });
    assert({
      given: 'four channels and no key in .env',
      should: 'create four webhooks and mint one key',
      actual: [
        actions.filter((a) => a.kind === 'createWebhook').length,
        actions.filter((a) => a.kind === 'mintKey').length,
      ],
      expected: [4, 1],
    });
  });

  test('creates the Agent role before minting the key with it', () => {
    assert({
      given: 'a drive with no Agent role and no key',
      should: 'create the role, then mint the key',
      actual: actions
        .filter((a) => a.kind === 'ensureAgentRole' || a.kind === 'mintKey')
        .map(describeAction),
      expected: [
        'create drive role "Agent" (drive-wide view and edit, no share)',
        'mint drive-scoped key (role Agent, browser consent) → .env PAGESPACE_TOKEN',
      ],
    });
  });

  test('flags', () => {
    const skipped = planBootstrap(config, manifest, empty, {
      ...options,
      skipWebhooks: true,
      skipKey: true,
      docsWorkflows: true,
    });
    assert({
      given: '--skip-webhooks --skip-key --docs-workflows',
      should: 'plan no webhook or key, and one workflow per manifest entry',
      actual: [
        kinds(skipped).includes('createWebhook'),
        kinds(skipped).includes('mintKey'),
        kinds(skipped).filter((k) => k === 'createWorkflow').length,
      ],
      expected: [false, false, manifest.docsWorkflows.length],
    });
  });
});

describe('planBootstrap on a provisioned drive', () => {
  test('is idempotent', () => {
    assert({
      given: 'a drive where every node, status, env key and setting exists',
      should: 'only keep nodes and re-render AGENTS.md',
      actual: [
        ...new Set(
          kinds(
            planBootstrap(provisionedConfig, manifest, provisioned, options),
          ),
        ),
      ],
      expected: ['keep', 'renderAgentsMd'],
    });
  });

  test('repairs only what is missing', () => {
    const nodes = fullNodes();
    delete nodes.blog;
    nodes.roadmap = { ...nodes.roadmap, statuses: ['ready'] };
    nodes.conventions = { ...nodes.conventions, empty: true };
    const env = new Set(
      [...ALL_ENV].filter(
        (key) => key !== 'PAGESPACE_INCIDENTS_WEBHOOK_SECRET',
      ),
    );
    const actions = planBootstrap(
      config,
      manifest,
      { ...provisioned, nodes, env },
      options,
    );
    assert({
      given:
        'a deleted canvas, two missing roadmap statuses, an empty conventions page and a lost webhook secret',
      should:
        'recreate and seed the canvas, add the statuses, seed the page and recreate that one webhook',
      actual: actions
        .filter((a) => a.kind !== 'keep' && a.kind !== 'recordId')
        .map(describeAction),
      expected: [
        'create CANVAS blog "Blog" under documentation → pages.blog',
        'add status in_review (in_progress) to roadmap',
        'add status merged (in_progress) to roadmap',
        'seed conventions from drive-seed/pages/conventions.html',
        'seed blog from drive-seed/docs/blog.html',
        'create incoming webhook on incidents → .env PAGESPACE_INCIDENTS_WEBHOOK_URL, PAGESPACE_INCIDENTS_WEBHOOK_SECRET',
        'render the AGENTS.md drive block between <!-- drive:start --> and <!-- drive:end -->',
      ],
    });
    assert({
      given: 'nodes found in the drive whose ids the config does not record',
      should:
        'record each one into its config slot rather than create a duplicate',
      actual: actions.filter((a) => a.kind === 'recordId').length,
      expected: manifest.nodes.filter(
        (node) => node.config && node.ref !== 'blog',
      ).length,
    });
  });
});

describe('planBootstrap on the Agent role and key', () => {
  test('re-mints a key that cannot edit', () => {
    assert({
      given: 'a PAGESPACE_TOKEN in .env that cannot edit the Roadmap',
      should: 'mint a replacement with the Agent role, and only that',
      actual: planBootstrap(
        provisionedConfig,
        manifest,
        { ...provisioned, agentKeyValid: false },
        { ...options, github: true },
      )
        .filter((a) => a.kind !== 'keep' && a.kind !== 'renderAgentsMd')
        .map(describeAction),
      expected: [
        'mint drive-scoped key (role Agent, browser consent) → .env PAGESPACE_TOKEN, replacing a token that cannot edit (+ GitHub secret)',
      ],
    });
  });

  test('resets a drifted role in place', () => {
    const plan = planBootstrap(
      provisionedConfig,
      manifest,
      {
        ...provisioned,
        agentRole: { id: AGENT_ROLE_ID, view: true, edit: false, share: true },
      },
      options,
    );
    assert({
      given: 'an Agent role without edit and with share',
      should: 'reset that role, not create another or re-mint',
      actual: plan
        .filter((a) => a.kind !== 'keep' && a.kind !== 'renderAgentsMd')
        .map(describeAction),
      expected: [
        `reset drive role "Agent" ${AGENT_ROLE_ID} to drive-wide view and edit, no share`,
      ],
    });
  });

  test('--skip-key still ensures the role', () => {
    assert({
      given: '--skip-key on a drive without the Agent role',
      should: 'create the role and mint nothing',
      actual: kinds(
        planBootstrap(
          provisionedConfig,
          manifest,
          { ...provisioned, agentRole: null, agentKeyValid: false },
          { ...options, skipKey: true },
        ),
      ).filter((k) => k === 'ensureAgentRole' || k === 'mintKey'),
      expected: ['ensureAgentRole'],
    });
  });
});

describe('formatPlan', () => {
  test('summarises without secrets', () => {
    const text = formatPlan(
      planBootstrap(provisionedConfig, manifest, provisioned, options),
    );
    assert({
      given: 'a plan of keeps',
      should: 'collapse keeps into a count',
      actual: text,
      expected: `  1. render the AGENTS.md drive block between <!-- drive:start --> and <!-- drive:end -->\n${manifest.nodes.length} existing node(s) kept unchanged.`,
    });
  });
});

describe('parseManifest', () => {
  test('fails closed', () => {
    const raw = manifestJson() as { nodes: Record<string, unknown>[] };
    const broken = {
      ...raw,
      nodes: [
        ...raw.nodes,
        {
          ref: 'stray',
          config: null,
          title: 'Stray',
          type: 'TASK',
          parent: 'standards',
        },
      ],
    };
    let message = 'no error';
    try {
      parseManifest(broken);
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a TASK node whose parent is a folder',
      should: 'refuse the manifest, naming the node',
      actual: message,
      expected:
        'drive-seed/manifest.json: stray is a TASK, so its parent must be a TASK_LIST',
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { executePlan } from './drive-bootstrap-exec';
import {
  checkReport,
  inspectDrive,
  readOnly,
  validateSeed,
} from './drive-bootstrap-inspect';
import { parseManifest } from './drive-bootstrap-manifest';
import { planBootstrap, type BootstrapOptions } from './drive-bootstrap-plan';
import { parseProjectConfig } from './project-config';
import {
  fakeDrive,
  manifestJson,
  paths,
  templateConfigText,
} from './drive-bootstrap-fake.test-support';

setupRitewayBun();

const manifest = parseManifest(manifestJson());
const options: BootstrapOptions = {
  skipWebhooks: false,
  skipKey: false,
  github: true,
  docsWorkflows: true,
  keyRole: 'member',
};
const AGENTS =
  '# Agents\n\n<!-- drive:start -->\nplaceholder\n<!-- drive:end -->\n';

/** One full bootstrap pass against the fake drive, as `main` runs it. */
async function bootstrap(fake: ReturnType<typeof fakeDrive>) {
  const config = parseProjectConfig(
    JSON.parse(fake.files.get(paths.config) ?? ''),
  );
  const { state, problems } = await inspectDrive(
    config,
    manifest,
    fake.transport,
    fake.files.get(paths.env) ?? '',
    true,
  );
  const actions = planBootstrap(config, manifest, state, options);
  const existing = Object.fromEntries(
    Object.entries(state.nodes).map(([ref, node]) => [ref, node.id]),
  );
  await executePlan(actions, {
    manifest,
    transport: fake.transport,
    paths,
    existing,
    driveId: state.drive?.id ?? null,
  });
  return { actions, problems };
}

function seeded(failOnCall?: number) {
  const fake = fakeDrive({ failOnCall });
  fake.files.set(paths.config, templateConfigText());
  fake.files.set(paths.env, 'DATABASE_URL=postgres://local\n');
  fake.files.set(paths.agents, AGENTS);
  return fake;
}

const errorOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('validateSeed', () => {
  test('the committed seed', () => {
    const fake = seeded();
    assert({
      given: 'drive-seed/ and the template config',
      should: 'find every seed file and resolve every placeholder name',
      actual: validateSeed(
        parseProjectConfig(JSON.parse(templateConfigText())),
        manifest,
        fake.transport,
        paths.seed,
      ),
      expected: [],
    });
  });
});

describe('executePlan from the empty template', async () => {
  const fake = seeded();
  await bootstrap(fake);
  const config = parseProjectConfig(
    JSON.parse(fake.files.get(paths.config) ?? ''),
  );
  const env = fake.files.get(paths.env) ?? '';
  const ids = [
    config.pagespace.driveId,
    ...Object.values(config.pagespace.pages),
    ...Object.values(config.pagespace.channels),
    ...Object.values(config.pagespace.agents),
  ];

  test('provisions and records every slot', () => {
    assert({
      given: 'a full run',
      should: 'write a real id into every config slot',
      actual: ids.filter((value) => value === null).length,
      expected: 0,
    });
    assert({
      given: 'the created pages',
      should:
        'put the conventions page under Engineering Standards and set Roadmap as home',
      actual: [
        fake.pages.get(config.pagespace.pages.conventions ?? '')?.parentId ===
          [...fake.pages.values()].find(
            (p) => p.title === 'Engineering Standards',
          )?.id,
        fake.drives[0].homePageId === config.pagespace.pages.roadmap,
      ],
      expected: [true, true],
    });
  });

  test('seeds resolved content', () => {
    const bodies = fake.calls
      .filter((call) => call.method === 'PATCH' || call.method === 'PUT')
      .map((call) => JSON.stringify(call.body));
    assert({
      given: 'every content, agent prompt and drive context write',
      should: 'carry no unresolved placeholder',
      actual: bodies.filter((body) => body.includes('{{')).length,
      expected: 0,
    });
    assert({
      given: 'the seeded conventions page',
      should: 'mention the Roadmap by its new id',
      actual: (
        fake.pages.get(config.pagespace.pages.conventions ?? '')?.content ?? ''
      ).includes(`data-page-id="${config.pagespace.pages.roadmap}"`),
      expected: true,
    });
  });

  test('credentials go to .env and GitHub, never to the log', () => {
    assert({
      given: 'the merged .env',
      should:
        'keep the unrelated key and hold the token and all eight webhook keys',
      actual: [
        env.startsWith('DATABASE_URL=postgres://local\n'),
        env.includes('PAGESPACE_TOKEN=mcp_fakeTokenDoNotPrint'),
        (env.match(/_WEBHOOK_(URL|SECRET)=/g) ?? []).length,
      ],
      expected: [true, true, 8],
    });
    assert({
      given: '--github',
      should: 'pass each secret on stdin, never in argv',
      actual: fake.commands
        .filter((c) => c.command[0] === 'gh')
        .every((c) => c.stdin && !c.command.join(' ').includes(c.stdin)),
      expected: true,
    });
    assert({
      given: 'everything the run logged',
      should: 'contain no token or webhook secret',
      actual: fake.logs.some((line) => /do-not-print|DoNotPrint/i.test(line)),
      expected: false,
    });
    assert({
      given: 'AGENTS.md with drive markers',
      should: 'render the new drive id into the block',
      actual: (fake.files.get(paths.agents) ?? '').includes(
        `(\`${config.pagespace.driveId}\``,
      ),
      expected: true,
    });
  });

  test('a rerun is a no-op', async () => {
    const writesBefore = fake.calls.filter(
      (call) => call.method !== 'GET',
    ).length;
    const { actions, problems } = await bootstrap(fake);
    assert({
      given: 'a second run against the provisioned drive',
      should: 'find no problem and send no write',
      actual: [
        problems.length,
        [...new Set(actions.map((a) => a.kind))],
        fake.calls.filter((call) => call.method !== 'GET').length -
          writesBefore,
      ],
      expected: [0, ['keep', 'renderAgentsMd'], 0],
    });
  });
});

describe('resuming after a crash', () => {
  test('keeps saved ids and finishes without duplicates', async () => {
    const fake = seeded(12);
    const crash = await errorOf(() => bootstrap(fake));
    const midway = parseProjectConfig(
      JSON.parse(fake.files.get(paths.config) ?? ''),
    );
    assert({
      given: 'a failure on the 12th write',
      should: 'stop with the drive id and the ids created so far already saved',
      actual: [
        crash.startsWith('injected failure'),
        midway.pagespace.driveId !== null,
        midway.pagespace.pages.roadmap !== null,
      ],
      expected: [true, true, true],
    });
    // The injected failure fires once; the rerun hits the same drive.
    await bootstrap(fake);
    const config = parseProjectConfig(
      JSON.parse(fake.files.get(paths.config) ?? ''),
    );
    const live = [...fake.pages.values()].filter((page) => !page.isTrashed);
    const duplicates = live.filter((page) =>
      live.some(
        (other) =>
          other !== page &&
          other.title === page.title &&
          other.parentId === page.parentId,
      ),
    );
    assert({
      given: 'a rerun after the crash',
      should: 'complete every slot and create no page twice',
      actual: [
        Object.values(config.pagespace.pages).includes(null),
        duplicates.length,
        live.length,
      ],
      expected: [false, 0, manifest.nodes.length],
    });
  });
});

describe('inspectDrive', () => {
  test('reports drift and the check refuses it', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const config = parseProjectConfig(
      JSON.parse(fake.files.get(paths.config) ?? ''),
    );
    const blog = fake.pages.get(config.pagespace.pages.blog ?? '');
    if (blog) blog.isTrashed = true;
    const roadmap = fake.pages.get(config.pagespace.pages.roadmap ?? '');
    if (roadmap) roadmap.type = 'DOCUMENT';
    const { problems } = await inspectDrive(
      config,
      manifest,
      readOnly(fake.transport),
      '',
      false,
    );
    assert({
      given: 'a trashed canvas and a page of the wrong type',
      should: 'report both against their refs',
      actual: checkReport(problems),
      expected: [
        'drive check FAILED:',
        `  - roadmap: ${config.pagespace.pages.roadmap} is a DOCUMENT, expected TASK_LIST`,
        `  - blog: ${config.pagespace.pages.blog} is in the trash`,
      ].join('\n'),
    });
  });

  test('read-only transport', async () => {
    const fake = seeded();
    assert({
      given: 'a write through the dry-run transport',
      should: 'be refused before it reaches PageSpace',
      actual: [
        await errorOf(() =>
          readOnly(fake.transport).api('POST', '/api/drives', { name: 'x' }),
        ),
        fake.calls.length,
      ],
      expected: ['read-only: refused POST /api/drives', 0],
    });
  });
});

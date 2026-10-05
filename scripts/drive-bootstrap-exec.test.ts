import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { inspectBootstrap } from './drive-bootstrap-access';
import { executePlan } from './drive-bootstrap-exec';
import { checkReport, readOnly, validateSeed } from './drive-bootstrap-inspect';
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
};
const AGENTS =
  '# Agents\n\n<!-- drive:start -->\nplaceholder\n<!-- drive:end -->\n';

type Fake = ReturnType<typeof fakeDrive>;

const configOf = (fake: Fake) =>
  parseProjectConfig(JSON.parse(fake.files.get(paths.config) ?? ''));

/** Inspects the fake drive as `main` does, the agent key read from .env. */
const inspect = (fake: Fake, withWorkflows = true) => {
  const envText = fake.files.get(paths.env) ?? '';
  return inspectBootstrap(configOf(fake), manifest, readOnly(fake.transport), {
    envText,
    withWorkflows,
    agentKey: envText.includes('PAGESPACE_TOKEN=')
      ? readOnly(fake.transport)
      : null,
  });
};

/** One full bootstrap pass against the fake drive, as `main` runs it. */
async function bootstrap(fake: Fake) {
  const config = configOf(fake);
  const { state, problems } = await inspect(fake);
  const actions = planBootstrap(config, manifest, state, options);
  await executePlan(actions, {
    manifest,
    transport: fake.transport,
    paths,
    state,
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

describe('the Agent role and key', () => {
  test('a fresh drive gets an editing role and a key minted with it', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const config = configOf(fake);
    const mint = fake.commands.find((c) => c.command[1] === 'keys')?.command;
    const roleAt = mint?.indexOf('--role') ?? -1;
    const nameAt = mint?.indexOf('--name') ?? -1;
    assert({
      given: 'a run against the empty template',
      should:
        'create one Agent role with drive-wide view and edit and no share',
      actual: fake.roles.map((role) => ({
        driveId: role.driveId,
        name: role.name,
        grant: role.driveWidePermissions,
      })),
      expected: [
        {
          driveId: config.pagespace.driveId ?? '',
          name: 'Agent',
          grant: { canView: true, canEdit: true, canShare: false },
        },
      ],
    });
    assert({
      given: 'the minted key',
      should: 'carry the Agent role id and the <name>-agent key name',
      actual: [mint?.[roleAt + 1], mint?.[nameAt + 1]],
      expected: [fake.roles[0]?.id, `${config.name}-agent`],
    });
  });

  test('a key minted with MEMBER is caught and replaced', async () => {
    const fake = seeded();
    await bootstrap(fake);
    // The live bug: a MEMBER key is view-only on the Roadmap.
    fake.key.role = 'member';
    const { problems } = await inspect(fake);
    assert({
      given: 'a PAGESPACE_TOKEN minted with the MEMBER role',
      should: 'fail the check with the fix',
      actual: checkReport(problems),
      expected: [
        'drive check FAILED:',
        '  - PAGESPACE_TOKEN: cannot edit the Roadmap: rerun `bun drive:bootstrap` to mint a key with the Agent role, then revoke the old one (`pagespace keys list`, `pagespace keys revoke`)',
      ].join('\n'),
    });
    const mintsBefore = fake.commands.length;
    const { actions } = await bootstrap(fake);
    const after = await inspect(fake);
    assert({
      given: 'a rerun of the bootstrap',
      should:
        'mint one replacement key with the Agent role and leave a clean check',
      actual: [
        actions.flatMap((a) => (a.kind === 'mintKey' ? [a.replaces] : [])),
        fake.commands.slice(mintsBefore).filter((c) => c.command[1] === 'keys')
          .length,
        fake.key.role === fake.roles[0]?.id,
        after.problems,
      ],
      expected: [[true], 1, true, []],
    });
  });

  test('a drifted role is reported and reset without a new key', async () => {
    const fake = seeded();
    await bootstrap(fake);
    const role = fake.roles[0];
    if (role)
      role.driveWidePermissions = {
        canView: true,
        canEdit: true,
        canShare: true,
      };
    const { problems } = await inspect(fake);
    assert({
      given: 'an Agent role someone granted share',
      should: 'report it against the role',
      actual: problems.map((problem) => problem.message),
      expected: [
        `drive role "Agent" ${role?.id} grants view=true edit=true share=true; expected view=true edit=true share=false`,
      ],
    });
    const mintsBefore = fake.commands.length;
    await bootstrap(fake);
    assert({
      given: 'a rerun of the bootstrap',
      should: 'reset the grant in place, keep the key and pass the check',
      actual: [
        fake.roles.length,
        role?.driveWidePermissions,
        fake.commands.length - mintsBefore,
        (await inspect(fake)).problems,
      ],
      expected: [1, { canView: true, canEdit: true, canShare: false }, 0, []],
    });
  });

  test('a missing token fails the check', async () => {
    const fake = seeded();
    await bootstrap(fake);
    fake.files.set(paths.env, 'DATABASE_URL=postgres://local\n');
    assert({
      given: '.env without PAGESPACE_TOKEN',
      should: 'name the missing key and how to mint it',
      actual: (await inspect(fake)).problems,
      expected: [
        {
          ref: 'PAGESPACE_TOKEN',
          message: 'is not set in .env: rerun `bun drive:bootstrap` to mint it',
        },
      ],
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
    const { problems } = await inspect(fake, false);
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

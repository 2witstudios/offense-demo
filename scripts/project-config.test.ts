import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  driveProvisioned,
  driveSkipNotice,
  driveUrl,
  loadProjectConfig,
  parseProjectConfig,
  repoUrl,
  requireAgent,
  requireChannel,
  requireDriveId,
  requirePage,
} from './project-config';
import {
  fakeId,
  provisionedConfig,
  provisionedConfigJson,
  thrown,
  unprovisionedConfig,
} from './project-config.test-support';

setupRitewayBun();

const raw = provisionedConfigJson;

describe('parseProjectConfig', () => {
  test('accepts a provisioned config and keeps every id', () => {
    const config = provisionedConfig();
    assert({
      given: 'a fully provisioned config',
      should: 'return the identity, gates and every drive id',
      actual: {
        repo: config.repo,
        checks: config.gates.requiredChecks,
        drive: config.pagespace.driveId,
        issues: config.pagespace.pages.issues,
        epicUpdates: config.pagespace.channels.epicUpdates,
        reviewer: config.pagespace.agents.reviewer,
      },
      expected: {
        repo: '2witstudios/offense-demo',
        checks: ['CI gate', 'Playwright E2E'],
        drive: fakeId('drive'),
        issues: fakeId('p', 'issues'),
        epicUpdates: fakeId('c', 'epicUpdates'),
        reviewer: fakeId('a', 'reviewer'),
      },
    });
  });

  test('fills omitted ids with null', () => {
    const json = raw();
    const pages = Object.fromEntries(
      Object.entries(json.pagespace.pages).filter(([key]) => key !== 'blog'),
    );
    assert({
      given: 'a config whose pages map omits blog',
      should: 'treat the missing page as unprovisioned',
      actual: parseProjectConfig({
        ...json,
        pagespace: { ...json.pagespace, pages },
      }).pagespace.pages.blog,
      expected: null,
    });
  });

  test('fails closed on each malformed field, naming it', () => {
    const json = raw();
    assert({
      given: 'configs with one malformed field each',
      should: 'refuse with the field path and the rule it broke',
      actual: [
        thrown(() => parseProjectConfig({ ...json, version: 2 })),
        thrown(() => parseProjectConfig({ ...json, name: 'Offense Demo' })),
        thrown(() => parseProjectConfig({ ...json, repo: 'offense-demo' })),
        thrown(() =>
          parseProjectConfig({ ...json, autonomyEnv: 'agent_autonomous' }),
        ),
        thrown(() =>
          parseProjectConfig({
            ...json,
            gates: { ...json.gates, requiredChecks: 'CI gate' },
          }),
        ),
        thrown(() =>
          parseProjectConfig({
            ...json,
            pagespace: { ...json.pagespace, apiUrl: 'http://pagespace.ai' },
          }),
        ),
        thrown(() =>
          parseProjectConfig({
            ...json,
            pagespace: { ...json.pagespace, driveId: 'not-a-cuid' },
          }),
        ),
        thrown(() =>
          parseProjectConfig({
            ...json,
            pagespace: {
              ...json.pagespace,
              pages: { ...json.pagespace.pages, wiki: null },
            },
          }),
        ),
        thrown(() => parseProjectConfig([])),
      ],
      expected: [
        'project.config.json: version must be 1',
        'project.config.json: name must match /^[a-z][a-z0-9-]{0,38}$/',
        'project.config.json: repo must match /^[A-Za-z0-9-]+\\/[A-Za-z0-9._-]+$/',
        'project.config.json: autonomyEnv must match /^[A-Z][A-Z0-9_]*$/',
        'project.config.json: gates.requiredChecks must be an array',
        'project.config.json: pagespace.apiUrl must be https',
        'project.config.json: pagespace.driveId must match /^[a-z0-9]{24}$/',
        'project.config.json: pagespace.pages.wiki is not a known key',
        'project.config.json: root must be an object',
      ],
    });
  });
});

describe('require helpers', () => {
  test('return provisioned ids', () => {
    const config = provisionedConfig();
    assert({
      given: 'a provisioned config',
      should: 'return the drive, page, channel and agent ids',
      actual: [
        requireDriveId(config),
        requirePage(config, 'reviews'),
        requireChannel(config, 'standup'),
        requireAgent(config, 'builder'),
      ],
      expected: [
        fakeId('drive'),
        fakeId('p', 'reviews'),
        fakeId('c', 'standup'),
        fakeId('a', 'builder'),
      ],
    });
  });

  test('refuse unprovisioned ids with a bootstrap hint', () => {
    const config = unprovisionedConfig();
    const hint =
      'is not provisioned in project.config.json; run `bun drive:bootstrap`';
    assert({
      given: 'a config whose drive is not bootstrapped',
      should: 'name the missing key and the bootstrap command',
      actual: [
        thrown(() => requireDriveId(config)),
        thrown(() => requirePage(config, 'reviews')),
        thrown(() => requireChannel(config, 'standup')),
        thrown(() => requireAgent(config, 'builder')),
      ],
      expected: [
        `pagespace.driveId ${hint}`,
        `pagespace.pages.reviews ${hint}`,
        `pagespace.channels.standup ${hint}`,
        `pagespace.agents.builder ${hint}`,
      ],
    });
  });
});

describe('URLs', () => {
  test('derive the drive dashboard and GitHub URLs', () => {
    const config = provisionedConfig();
    assert({
      given: 'a provisioned config',
      should: 'build the drive dashboard URL on the API host and the repo URL',
      actual: [driveUrl(config), repoUrl(config)],
      expected: [
        `https://pagespace.ai/dashboard/${fakeId('drive')}`,
        'https://github.com/2witstudios/offense-demo',
      ],
    });
  });
});

describe('the committed project.config.json', () => {
  test('parses, and holds no PageSpace id before bootstrap or only valid ones after', () => {
    const config = loadProjectConfig(new URL('..', import.meta.url).pathname);
    const ids = [
      config.pagespace.driveId,
      ...Object.values(config.pagespace.pages),
      ...Object.values(config.pagespace.channels),
      ...Object.values(config.pagespace.agents),
    ];
    assert({
      given: 'the repository config',
      should: 'validate and carry only null or cuid2-shaped ids',
      actual: ids.every((id) => id === null || /^[a-z0-9]{24}$/.test(id)),
      expected: true,
    });
  });
});

describe('driveProvisioned', () => {
  test('tells a provisioned drive from the template default', () => {
    assert({
      given: 'a config with a drive id and one with none',
      should: 'be true only for the provisioned drive',
      actual: [
        driveProvisioned(provisionedConfig()),
        driveProvisioned(unprovisionedConfig()),
      ],
      expected: [true, false],
    });
  });

  test('names the skipped work and the fix in a CI notice', () => {
    assert({
      given: 'a skipped merge follow-up',
      should: 'emit a GitHub notice that points at drive:bootstrap',
      actual:
        driveSkipNotice('merge follow-up').startsWith(
          '::notice::merge follow-up skipped',
        ) && driveSkipNotice('x').includes('bun drive:bootstrap'),
      expected: true,
    });
  });
});

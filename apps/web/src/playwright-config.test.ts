import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import playwrightConfig, {
  resolveBrowserEndpoint,
  resolveE2EPort,
  resolveE2EServices,
  resolveRealtimeNamespace,
  resolveReuseExistingServer,
  runsVisualProject,
} from '../playwright.config';

setupRitewayBun();

describe('Playwright failure artifacts', () => {
  test('retains screenshots and videos alongside the retained trace', () => {
    assert({
      given: 'a failing browser test',
      should: 'retain all diagnostic artifacts for the failure',
      actual: {
        screenshot: playwrightConfig.use?.screenshot,
        video: playwrightConfig.use?.video,
        trace: playwrightConfig.use?.trace,
      },
      expected: {
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
      },
    });
  });
});

describe('Playwright Chromium TLS', () => {
  test('accepts the edge certificate at the TLS layer in every Chromium project', () => {
    const chromium = (playwrightConfig.projects ?? []).filter((project) =>
      project.name?.startsWith('chromium'),
    );
    assert({
      given:
        'the per-run self-signed edge certificate, which ignoreHTTPSErrors alone answers by restarting requests (ISSUE-21)',
      should: 'launch each Chromium project with certificate errors ignored',
      actual: chromium.map((project) => [
        project.name,
        project.use?.launchOptions?.args?.includes(
          '--ignore-certificate-errors',
        ),
      ]),
      expected: [
        ['chromium', true],
        ['chromium-mobile', true],
      ],
    });
  });
});

describe('Playwright Firefox form history', () => {
  test('turns form history off in every Firefox project', () => {
    const firefox = (playwrightConfig.projects ?? []).filter((project) =>
      project.name?.startsWith('firefox'),
    );
    assert({
      given:
        'an address already submitted once, whose history dropdown Firefox opens asynchronously after a fill and which can then take the next synthesized click (ISSUE-186)',
      should: 'launch each Firefox project with browser.formfill.enable off',
      actual: firefox.map((project) => [
        project.name,
        project.use?.launchOptions?.firefoxUserPrefs?.[
          'browser.formfill.enable'
        ],
      ]),
      expected: [['firefox', false]],
    });
  });
});

describe('Playwright port resolution', () => {
  test('defaults to the canonical port', () => {
    assert({
      given: 'an environment without a pinned port',
      should: 'use the canonical e2e port',
      actual: resolveE2EPort({}),
      expected: 3100,
    });
  });

  test('pinned E2E_PORT moves the suite to a parallel session port', () => {
    assert({
      given: 'E2E_PORT from a parallel session slot',
      should: 'derive the server port from it',
      actual: resolveE2EPort({ E2E_PORT: '13100' }),
      expected: 13100,
    });
  });
});

describe('Playwright slot services', () => {
  test('uses exactly the slot database and Redis namespace it is given', () => {
    assert({
      given: 'the e2e values bun slot:up writes for a worktree',
      should: 'pass them to the production server unchanged',
      actual: resolveE2EServices({
        E2E_DATABASE_URL:
          'postgres://offense_demo_e2e:e2e-loopback-only@localhost:15432/offense_demo_wt_abc_e2e',
        E2E_REDIS_URL: 'redis://localhost:6379/2',
        E2E_REDIS_NAMESPACE: 'offense-demo-wt-abc-e2e',
      }),
      expected: {
        DATABASE_URL:
          'postgres://offense_demo_e2e:e2e-loopback-only@localhost:15432/offense_demo_wt_abc_e2e',
        REDIS_URL: 'redis://localhost:6379/2',
        REDIS_NAMESPACE: 'offense-demo-wt-abc-e2e',
      },
    });
  });

  test('never falls back to another slot when a value is missing', () => {
    assert({
      given: 'an environment without the e2e slot values',
      should:
        'pass empty values the server configuration rejects, never a default database',
      actual: resolveE2EServices({}),
      expected: { DATABASE_URL: '', REDIS_URL: '', REDIS_NAMESPACE: '' },
    });
  });
});

describe('Playwright realtime namespace', () => {
  test('adds a -realtime suffix when it still fits REDIS_NAMESPACE', () => {
    assert({
      given: 'a short e2e slot namespace',
      should: 'append -realtime',
      actual: resolveRealtimeNamespace({
        E2E_REDIS_NAMESPACE: 'offense-demo-wt-abc-e2e',
      }),
      expected: 'offense-demo-wt-abc-e2e-realtime',
    });
  });

  test('shares the namespace when a -realtime suffix would exceed the 63-character limit', () => {
    // A worktree slot's E2E_REDIS_NAMESPACE can already be at the limit
    // (scripts/slot-naming.ts sizes slot ids to fill it).
    const atLimit = `a${'b'.repeat(58)}-e2e`;
    assert({
      given: "a namespace already at REDIS_NAMESPACE's 63-character limit",
      should:
        'fall back to sharing it rather than producing an invalid namespace',
      actual: resolveRealtimeNamespace({ E2E_REDIS_NAMESPACE: atLimit }),
      expected: atLimit,
    });
  });

  test('an empty namespace fails closed rather than producing "-realtime"', () => {
    assert({
      given: 'no e2e slot namespace configured',
      should:
        'resolve to the same empty string resolveE2EServices already produces, never a bare "-realtime"',
      actual: resolveRealtimeNamespace({}),
      expected: '',
    });
  });
});

describe('Playwright server reuse policy', () => {
  test('never reuses an existing server in CI', () => {
    assert({
      given: 'a CI environment',
      should: 'always boot a fresh production server',
      actual: resolveReuseExistingServer({ CI: 'true', E2E_PORT: '13100' }),
      expected: false,
    });
  });

  test('reuses only the unpinned default port locally', () => {
    assert({
      given: 'a local run without a pinned port',
      should: 'reuse an existing server',
      actual: resolveReuseExistingServer({}),
      expected: true,
    });
  });

  test('explicit slot services disable reuse even on the default port', () => {
    assert({
      given:
        'e2e database, Redis URL or namespace settings without a pinned port',
      should: 'boot its own server so those settings are actually applied',
      actual: [
        resolveReuseExistingServer({ E2E_DATABASE_URL: 'postgres://x/y_test' }),
        resolveReuseExistingServer({ E2E_REDIS_URL: 'redis://x/2' }),
        resolveReuseExistingServer({
          E2E_REDIS_NAMESPACE: 'offense-demo-wt-abc-e2e',
        }),
      ],
      expected: [false, false, false],
    });
  });

  test('a pinned port disables reuse so sessions never test foreign code', () => {
    assert({
      given: 'a local run with an explicitly pinned port',
      should: 'fail loud instead of reusing another session server',
      actual: resolveReuseExistingServer({ E2E_PORT: '13100' }),
      expected: false,
    });
  });
});

describe('Playwright visual project', () => {
  test('runs natively on Linux', () => {
    assert({
      given: 'a Linux host with no browser endpoint',
      should: 'include the visual project',
      actual: runsVisualProject({}, 'linux'),
      expected: true,
    });
  });

  test('needs the Linux browser server elsewhere', () => {
    assert({
      given: 'a macOS host without and with a browser endpoint',
      should: 'exclude the project until the Linux browser server is set',
      actual: [
        runsVisualProject({}, 'darwin'),
        runsVisualProject({ PW_WS_ENDPOINT: 'ws://127.0.0.1:3000/' }, 'darwin'),
      ],
      expected: [false, true],
    });
  });

  test('treats an empty endpoint as unset', () => {
    assert({
      given: 'PW_WS_ENDPOINT set to an empty string',
      should: 'resolve no endpoint',
      actual: resolveBrowserEndpoint({ PW_WS_ENDPOINT: '' }),
      expected: undefined,
    });
  });
});

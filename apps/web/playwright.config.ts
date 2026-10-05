import { defineConfig, devices } from '@playwright/test';

type Env = Readonly<Record<string, string | undefined>>;

// The signup/login/passkey/recovery journey specs (AUTH-6.6's "supported
// magic-link/account journeys"), run across every engine and mobile layout.
// Non-auth suites (shell, theme, CSP) stay
// Chromium-only: cross-browser parity for them is outside this epic's scope.
export const AUTH_JOURNEY_SPECS = [
  '**/journey.e2e.ts',
  '**/journey-no-js.e2e.ts',
  '**/onboarding.e2e.ts',
  '**/form-transport.e2e.ts',
  '**/answer-focus.e2e.ts',
  '**/passkey-lifecycle.e2e.ts',
  '**/email-change-and-sessions.e2e.ts',
  '**/accessibility.e2e.ts',
  '**/accessibility-keyboard.e2e.ts',
  '**/headings.e2e.ts',
  '**/auth-routes.e2e.ts',
  '**/csp-confirm.e2e.ts',
];
// Passkey autofill is proven through Chromium's CDP virtual authenticator,
// which answers a conditional request without browser UI, so it runs in both
// Chromium projects and no other engine.
const PASSKEY_AUTOFILL_SPEC = '**/passkey-autofill.e2e.ts';

// Ports derive from the environment; `bun slot:up` writes each checkout's
// own (docs/development/local-development.md, "Parallel sessions").
export const resolveE2EPort = (env: Env): number =>
  Number(env.E2E_PORT ?? 3100);
// The slot's database and Redis namespace come only from explicit settings
// (written by `bun slot:up`, set by CI). A missing value is passed as empty,
// which the server's configuration rejects at startup, so a suite can never
// silently run against another checkout's data.
export const resolveE2EServices = (env: Env) => ({
  DATABASE_URL: env.E2E_DATABASE_URL ?? '',
  REDIS_URL: env.E2E_REDIS_URL ?? '',
  REDIS_NAMESPACE: env.E2E_REDIS_NAMESPACE ?? '',
});
// realtime's REDIS_NAMESPACE stays its own slot-derived namespace with a
// `-realtime` suffix when that still fits REDIS_NAMESPACE's 63-character
// limit (a worktree slot's E2E_REDIS_NAMESPACE can already be at that
// limit); otherwise the two services share one namespace.
const redisNamespacePattern = /^[a-z][a-z0-9-]{0,62}$/;
export const resolveRealtimeNamespace = (env: Env): string => {
  const base = resolveE2EServices(env).REDIS_NAMESPACE;
  const candidate = `${base}-realtime`;
  return redisNamespacePattern.test(candidate) ? candidate : base;
};
// A reused server keeps whatever database and namespace it was started with
// and ignores webServer.env, so any explicit port or slot setting forces a
// fresh server: only a fully unconfigured local run may reuse. CI never
// reuses.
export const resolveReuseExistingServer = (env: Env): boolean =>
  !env.CI &&
  [
    env.E2E_PORT,
    env.E2E_DATABASE_URL,
    env.E2E_REDIS_URL,
    env.E2E_REDIS_NAMESPACE,
  ].every((value) => value === undefined);

// Screenshot parity is pixel-exact only in the Linux Playwright image that
// matches @playwright/test. `bun visual:server` runs that image's browser
// server; pointing PW_WS_ENDPOINT at it keeps the app on the host and the
// browser in Linux (docs/development/testing.md, "Visual parity").
export const resolveBrowserEndpoint = (env: Env): string | undefined =>
  env.PW_WS_ENDPOINT || undefined;
// Non-Linux hosts render fonts differently; without the Linux browser
// server they must not compare against Linux baselines.
export const runsVisualProject = (env: Env, platform: string): boolean =>
  platform === 'linux' || resolveBrowserEndpoint(env) !== undefined;

// One production server per run: the app on the pinned port, a loopback TLS
// edge on the next (production requires an HTTPS origin, and Secure session
// cookies need one in a real browser), the mail capture after that, and
// apps/realtime (ADR 0031) on the fourth — no handler logic exists yet
// (RT-2.3a), so nothing subscribes to it; it boots so a later two-browser
// journey (RT-2.7) has it available without another harness change.
export const resolveE2EPorts = (env: Env) => {
  const app = resolveE2EPort(env);
  return { app, edge: app + 1, mail: app + 2, realtime: app + 3 };
};
/** The public origin the server is configured with and the browser uses. */
export const resolveE2EOrigin = (env: Env): string =>
  `https://localhost:${resolveE2EPorts(env).edge}`;

// The edge's certificate is self-signed per run. Under ignoreHTTPSErrors
// alone, Chromium fails every new TLS connection to it and restarts the
// request; in a burst of parallel connections (a page's Link prefetches) a
// restarted request is handed other requests' failing connections until it
// runs out of restarts, and the page loses its stylesheet to
// ERR_TOO_MANY_RETRIES (ISSUE-21). Accepting the certificate at the TLS
// layer leaves nothing to restart. The restart path is Chromium's own.
const chromiumLaunch = { args: ['--ignore-certificate-errors'] };

// Firefox saves every submitted field value as form history and, on the next
// fill of a field with the same name, looks it up asynchronously and opens a
// suggestion dropdown in the browser chrome, under the field. Playwright
// closes that dropdown before it synthesizes a click, but a lookup that
// answers after the close (under load) reopens it over the button below, and
// the click lands in the dropdown: the button is never pressed (ISSUE-186,
// an expired-link resend reusing the address /sign-in had just submitted).
// The dropdown is browser UI, not the app, so the suite runs without it.
const firefoxLaunch = {
  firefoxUserPrefs: { 'browser.formfill.enable': false },
};

const ports = resolveE2EPorts(process.env);
const origin = resolveE2EOrigin(process.env);
const browserEndpoint = resolveBrowserEndpoint(process.env);

export default defineConfig({
  testDir: './e2e',
  // `*.e2e.ts` keeps these files out of Bun's `*.spec.ts` test discovery.
  testMatch: '**/*.e2e.ts',
  snapshotPathTemplate: '{testDir}/visual-baselines/{arg}{ext}',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // A committed test.only would otherwise run alone and pass the gate
  // silently; refuse the whole run at collection time instead (ISSUE-164).
  // Off outside CI so a developer can still focus a test while iterating.
  forbidOnly: Boolean(process.env.CI),
  // Release qualification requires retries disabled: a retry-pass is a
  // flaky result, not proof (spec "Prevent tests from proving their own
  // fixtures"). CI always writes the json reporter so
  // scripts/e2e-report-counts.ts can report discovered/executed/pass/fail
  // counts and reject an empty selection.
  retries: 0,
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
      ]
    : 'list',
  use: {
    baseURL: origin,
    // The edge presents a per-run self-signed certificate for localhost.
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // Chromium carries the whole functional suite (app/dashboard chrome,
    // theme, CSP, auth) as the primary CI project, unchanged from before
    // AUTH-6.6. The spec's cross-browser/mobile requirement is scoped to
    // "the supported magic-link/account journeys", not the whole app, so
    // the added engines/layouts below testMatch only the auth-journey
    // specs, plus the passkey autofill proof for chromium-mobile. CDP
    // WebAuthn (navigator.credentials via a virtual authenticator) is
    // Chromium-only, so passkey-lifecycle.e2e.ts is additionally excluded
    // from every non-Chromium project.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunch },
      testIgnore: '**/visual.e2e.ts',
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 8'], launchOptions: chromiumLaunch },
      testMatch: [...AUTH_JOURNEY_SPECS, PASSKEY_AUTOFILL_SPEC],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], launchOptions: firefoxLaunch },
      testMatch: AUTH_JOURNEY_SPECS,
      testIgnore: '**/passkey-lifecycle.e2e.ts',
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: AUTH_JOURNEY_SPECS,
      testIgnore: '**/passkey-lifecycle.e2e.ts',
    },
    {
      name: 'webkit-mobile',
      use: { ...devices['iPhone 15'] },
      testMatch: AUTH_JOURNEY_SPECS,
      testIgnore: '**/passkey-lifecycle.e2e.ts',
    },
    ...(runsVisualProject(process.env, process.platform)
      ? [
          {
            name: 'visual',
            testMatch: '**/visual.e2e.ts',
            use: browserEndpoint
              ? {
                  connectOptions: {
                    wsEndpoint: browserEndpoint,
                    exposeNetwork: '<loopback>',
                  },
                }
              : {},
          },
        ]
      : []),
  ],
  webServer: [
    {
      // Keep structured server output beside Playwright's failure artifacts,
      // one log per app port so concurrent suites never share a file.
      command: `mkdir -p test-results && bun e2e/support/server.ts > test-results/server-${ports.app}.log 2>&1`,
      // Probe through the TLS edge, not the app port: the edge and the mail
      // capture live in the same wrapper process, so a reused server is only
      // accepted when all three listeners are up. Readiness, not liveness:
      // liveness answers 200 as soon as the port opens, while start.ts is
      // still preparing Next and every page answers 503 (ISSUE-172, ISSUE-197).
      url: `${origin}/api/health/ready`,
      ignoreHTTPSErrors: true,
      name: 'production web',
      timeout: 60_000,
      reuseExistingServer: resolveReuseExistingServer(process.env),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      env: {
        PORT: String(ports.app),
        E2E_EDGE_PORT: String(ports.edge),
        E2E_MAIL_PORT: String(ports.mail),
        NODE_ENV: 'production',
        // The production configuration refinements must hold: HTTPS public URL,
        // deployment identity, no development credentials.
        PUBLIC_APP_URL: origin,
        APP_VERSION: 'e2e',
        GIT_COMMIT: 'local-e2e',
        ...resolveE2EServices(process.env),
        LOG_LEVEL: 'info',
        // Production refuses to start without auth configuration. These are
        // inert placeholders: outbound mail is captured by the e2e server and
        // never reaches Resend, and no webhook is ever delivered.
        BETTER_AUTH_SECRET:
          'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
        RECIPIENT_HASH_SECRET:
          'a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2',
        RESEND_API_KEY: 're_e2e_placeholder_not_a_credential',
        AUTH_EMAIL_FROM: 'Offense Demo <no-reply@e2e.offense-demo.invalid>',
        RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLXBsYWNlaG9sZGVyLW5vdC1hLXNlY3JldA==',
        // AUTH-7.7: gates /api/ops/alerts and /api/ops/metrics; no probe
        // workflow runs against this local e2e server.
        OPS_PROBE_TOKEN: 'e2e-ops-probe-token-placeholder-not-a-credential',
      },
    },
    {
      // apps/realtime (ADR 0031): a plain Bun process, no Next build. One
      // log per port, matching web's own per-port naming above.
      command: `mkdir -p ../web/test-results && bun src/start.ts > ../web/test-results/realtime-${ports.realtime}.log 2>&1`,
      cwd: '../realtime',
      url: `http://127.0.0.1:${ports.realtime}/health/live`,
      name: 'realtime',
      timeout: 30_000,
      reuseExistingServer: resolveReuseExistingServer(process.env),
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      env: {
        REALTIME_PORT: String(ports.realtime),
        NODE_ENV: 'production',
        APP_VERSION: 'e2e',
        GIT_COMMIT: 'local-e2e',
        DATABASE_URL: resolveE2EServices(process.env).DATABASE_URL,
        REDIS_URL: resolveE2EServices(process.env).REDIS_URL,
        REDIS_NAMESPACE: resolveRealtimeNamespace(process.env),
        LOG_LEVEL: 'info',
      },
    },
  ],
});

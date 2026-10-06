import { generateKeyPairSync } from 'node:crypto';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  serveManifest,
  setupReviewApp,
  type ReviewAppDeps,
  type ReviewAppInput,
} from './github-review-app';
import type { GhResult } from './github-rules';

setupRitewayBun();

const REPO = 'octo/widget';
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const KEY_BODY = PEM.split('\n')[1] ?? '';

const okResult = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });
const missing: GhResult = { code: 1, stdout: '', stderr: 'HTTP 404' };

const BASE: Readonly<Record<string, GhResult>> = {
  [`api repos/${REPO}/actions/variables/REVIEW_RECORD_APP_ID`]: missing,
  [`api repos/${REPO}/environments/review-record/secrets/REVIEW_RECORD_APP_KEY`]:
    missing,
  [`api repos/${REPO}/actions/secrets/REVIEW_RECORD_APP_KEY`]: missing,
  'api users/octo --jq .type': okResult('User\n'),
  'api apps/widget-review-record': missing,
  'api -X POST app-manifests/the-code/conversions': okResult(
    JSON.stringify({
      id: 4242,
      slug: 'widget-review-record',
      pem: PEM,
      html_url: 'https://github.com/apps/widget-review-record',
      client_secret: 'never-shown',
    }),
  ),
  [`api -X PUT repos/${REPO}/environments/review-record --input -`]:
    okResult('{}'),
  [`api -X POST repos/${REPO}/environments/review-record/deployment-branch-policies`]:
    okResult('{}'),
  'secret set REVIEW_RECORD_APP_KEY': okResult(),
  'variable set REVIEW_RECORD_APP_ID': okResult(),
  [`api repos/${REPO} --jq .visibility`]: okResult('public\n'),
  'api user --jq .plan.name': okResult('free\n'),
};

type Options = {
  readonly answers?: Readonly<Record<string, GhResult>>;
  /** HTTP statuses GET /installation answers, in order (last repeats). */
  readonly installs?: readonly number[];
};

function fake(options: Options = {}) {
  const answers = { ...BASE, ...options.answers };
  const calls: { args: string; stdin: string | undefined }[] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  const pages: string[] = [];
  const jwts: string[] = [];
  const installs = [...(options.installs ?? [200])];
  let now = 1_700_000_000_000;
  let rulesApplied = 0;
  let served = 0;
  const deps: ReviewAppDeps = {
    gh: (args, stdin) => {
      const line = args.join(' ');
      calls.push({ args: line, stdin });
      const key = Object.keys(answers)
        .filter((prefix) => line === prefix || line.startsWith(`${prefix} `))
        .sort((a, b) => b.length - a.length)[0];
      return key
        ? (answers[key] as GhResult)
        : { code: 1, stdout: '', stderr: `unexpected: ${line}` };
    },
    open: (url) => opened.push(url),
    log: (line) => logs.push(line),
    serve: ({ page, state }) => {
      served += 1;
      pages.push(page(4567));
      pages.push(state);
      return {
        localUrl: 'http://127.0.0.1:4567/',
        code: Promise.resolve('the-code'),
        stop: () => {},
      };
    },
    appGet: async (path, jwt) => {
      jwts.push(`${path} ${jwt.split('.').length}`);
      return installs.length > 1 ? (installs.shift() ?? 0) : (installs[0] ?? 0);
    },
    sleep: async (ms) => {
      now += ms;
    },
    nowMs: () => now,
    randomHex: (bytes) => 'ab'.repeat(bytes),
    applyRules: () => {
      rulesApplied += 1;
      return 0;
    },
  };
  return {
    deps,
    calls,
    logs,
    opened,
    pages,
    jwts,
    rulesApplied: () => rulesApplied,
    served: () => served,
  };
}

const input = (overrides: Partial<ReviewAppInput> = {}): ReviewAppInput => ({
  repository: REPO,
  dryRun: false,
  force: false,
  autonomous: false,
  ...overrides,
});

describe('setupReviewApp', () => {
  test('the whole flow', async () => {
    const run = fake({ installs: [404, 404, 200] });
    const code = await setupReviewApp(input(), run.deps);
    const order = run.calls.map((call) => call.args.split(' -R ')[0]);
    assert({
      given: 'a user-owned repository with nothing set up',
      should:
        'create, store the key in the main-only environment, wait for the install, then set the id and apply the ruleset',
      actual: [code, order.slice(-7), run.opened, run.jwts, run.rulesApplied()],
      expected: [
        0,
        [
          'api -X POST app-manifests/the-code/conversions',
          `api -X PUT repos/${REPO}/environments/review-record --input -`,
          `api -X POST repos/${REPO}/environments/review-record/deployment-branch-policies -f name=main -f type=branch`,
          'secret set REVIEW_RECORD_APP_KEY --env review-record',
          'variable set REVIEW_RECORD_APP_ID --body 4242',
          `api repos/${REPO} --jq .visibility`,
          'api user --jq .plan.name',
        ],
        [
          'http://127.0.0.1:4567/',
          'https://github.com/apps/widget-review-record/installations/new',
        ],
        [
          `/repos/${REPO}/installation 3`,
          `/repos/${REPO}/installation 3`,
          `/repos/${REPO}/installation 3`,
        ],
        1,
      ],
    });
  });

  test('the private key never reaches argv or the log', async () => {
    const run = fake();
    await setupReviewApp(input(), run.deps);
    const secretSet = run.calls.find((call) =>
      call.args.startsWith('secret set'),
    );
    const everything = [
      ...run.calls.map((call) => call.args),
      ...run.logs,
      ...run.opened,
    ].join('\n');
    assert({
      given: 'a run that holds the App private key',
      should:
        'pass it only on the secret command stdin, never in any argv, log line or URL',
      actual: [
        secretSet?.stdin === PEM,
        everything.includes(KEY_BODY),
        everything.includes('never-shown'),
        run.calls.filter((call) => call.stdin === PEM).length,
      ],
      expected: [true, false, false, 1],
    });
  });

  test('the manifest page', async () => {
    const run = fake();
    await setupReviewApp(input(), run.deps);
    const [page = '', state = ''] = run.pages;
    assert({
      given: 'the page the local server serves',
      should:
        "post to the user's App settings with this run's random state and the callback port",
      actual: [
        page.includes(
          `action="https://github.com/settings/apps/new?state=${state}"`,
        ),
        state.length,
        page.includes('http://127.0.0.1:4567/callback'),
      ],
      expected: [true, 32, true],
    });
  });

  test('an organization owner', async () => {
    const run = fake({
      answers: { 'api users/octo --jq .type': okResult('Organization\n') },
    });
    await setupReviewApp(input(), run.deps);
    assert({
      given: 'a repository owned by an organization',
      should: "post the manifest to the organization's App settings",
      actual: (run.pages[0] ?? '').includes(
        'action="https://github.com/organizations/octo/settings/apps/new?state=',
      ),
      expected: true,
    });
  });

  test('a taken name gets a tag', async () => {
    const run = fake({
      answers: { 'api apps/widget-review-record': okResult('{}') },
    });
    await setupReviewApp(input({ dryRun: true }), run.deps);
    assert({
      given: 'an App called widget-review-record already exists',
      should: 'pick widget-abab-review-record',
      actual: run.logs.some((line) =>
        line.includes('"widget-abab-review-record"'),
      ),
      expected: true,
    });
  });

  test('idempotent', async () => {
    const run = fake({
      answers: {
        [`api repos/${REPO}/actions/variables/REVIEW_RECORD_APP_ID`]:
          okResult('{}'),
        [`api repos/${REPO}/environments/review-record/secrets/REVIEW_RECORD_APP_KEY`]:
          okResult('{}'),
      },
    });
    const code = await setupReviewApp(input(), run.deps);
    assert({
      given: 'the id variable and the key secret already exist',
      should: 'report, exit 0, and create, store and open nothing',
      actual: [
        code,
        run.served(),
        run.opened,
        run.calls.some((call) => !call.args.startsWith('api repos/')),
        run.logs[0]?.includes('already set up'),
      ],
      expected: [0, 0, [], false, true],
    });
  });

  test('dry run', async () => {
    const run = fake();
    const code = await setupReviewApp(input({ dryRun: true }), run.deps);
    assert({
      given: '--dry-run',
      should:
        'probe read-only, print the ten steps and serve, open or change nothing',
      actual: [
        code,
        run.served(),
        run.opened,
        run.calls.some(
          (call) => call.args.includes('-X') || !call.args.startsWith('api '),
        ),
        run.logs.length,
      ],
      expected: [0, 0, [], false, 11],
    });
  });

  test('the install never happens', async () => {
    const run = fake({ installs: [404] });
    const code = await setupReviewApp(input(), run.deps);
    assert({
      given: 'the App is not installed within the timeout',
      should:
        'exit 1, never set the id (the gate keeps skipping), and print how to finish',
      actual: [
        code,
        run.calls.some((call) => call.args.startsWith('variable set')),
        run.logs.some((line) =>
          line.includes(
            'gh variable set REVIEW_RECORD_APP_ID --body 4242 -R octo/widget',
          ),
        ),
        run.rulesApplied(),
      ],
      expected: [1, false, true, 0],
    });
  });

  test('private on a free plan', async () => {
    const run = fake({
      answers: {
        [`api repos/${REPO} --jq .visibility`]: okResult('private\n'),
      },
    });
    const code = await setupReviewApp(input(), run.deps);
    assert({
      given: 'a private repository on a free plan',
      should: 'not try the ruleset and explain why the gate is not enforced',
      actual: [
        code,
        run.rulesApplied(),
        run.logs.some((line) => line.includes('are NOT enforced')),
      ],
      expected: [0, 0, true],
    });
  });

  test('no environment', async () => {
    const run = fake({
      answers: {
        [`api -X PUT repos/${REPO}/environments/review-record --input -`]:
          missing,
      },
    });
    await setupReviewApp(input(), run.deps);
    assert({
      given: 'GitHub refuses the review-record environment',
      should: 'store a repository secret and say why that is weaker',
      actual: [
        run.calls.find((call) => call.args.startsWith('secret set'))?.args,
        run.logs.some((line) => line.includes('any workflow on any branch')),
      ],
      expected: ['secret set REVIEW_RECORD_APP_KEY -R octo/widget', true],
    });
  });

  test('refusals', async () => {
    const agent = fake();
    const named = fake();
    assert({
      given: 'an autonomous agent, and a 35-character --name',
      should: 'refuse before touching GitHub',
      actual: [
        await setupReviewApp(input({ autonomous: true }), agent.deps),
        agent.calls.length,
        await setupReviewApp(input({ name: 'x'.repeat(35) }), named.deps),
        named.calls.length,
      ],
      expected: [1, 0, 2, 0],
    });
  });
});

describe('serveManifest', () => {
  test('serves the page and takes only the matching callback', async () => {
    const session = serveManifest({
      page: (port) => `<p>port ${port}</p>`,
      state: 's1',
      timeoutMs: 60_000,
    });
    const page = await (await fetch(session.localUrl)).text();
    const forged = await fetch(
      new URL('/callback?code=evil&state=nope', session.localUrl),
    );
    const real = await fetch(
      new URL('/callback?code=good&state=s1', session.localUrl),
    );
    const code = await session.code;
    session.stop();
    assert({
      given: 'a forged callback, then GitHub’s with the right state',
      should:
        'serve the page on its own port, refuse the forgery, return the real code',
      actual: [
        page === `<p>port ${new URL(session.localUrl).port}</p>`,
        new URL(session.localUrl).hostname,
        forged.status,
        real.status,
        code,
      ],
      expected: [true, '127.0.0.1', 400, 200, 'good'],
    });
  });

  test('times out with a clear message', async () => {
    const session = serveManifest({
      page: () => '',
      state: 's1',
      timeoutMs: 1,
    });
    const message = await session.code.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    session.stop();
    assert({
      given: 'no redirect before the timeout',
      should: 'reject saying nothing was stored and how to retry',
      actual: message.includes(
        'Nothing was stored; run bun github:review-app again',
      ),
      expected: true,
    });
  });
});

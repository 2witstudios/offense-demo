#!/usr/bin/env bun
/**
 * Sets up the review-record GitHub App so the `review-record` merge gate
 * enforces, with the two browser clicks GitHub requires and nothing else:
 *
 *   bun github:review-app [--name <app name>] [--dry-run] [--force]
 *
 * 1. Posts the App manifest (github-review-app-plan.ts) from a one-shot
 *    127.0.0.1 page to GitHub; the owner clicks "Create GitHub App".
 * 2. Exchanges GitHub's redirect code for the App id, slug and private key;
 *    the key stays in memory and is never printed or put in argv.
 * 3. Restricts the `review-record` environment to main and stores the key
 *    there as REVIEW_RECORD_APP_KEY (gh secret set, key on stdin).
 * 4. Opens the install page; the owner installs it on the repository. The
 *    script polls GET /repos/{repo}/installation signed as the App.
 * 5. Sets REVIEW_RECORD_APP_ID only now, so the variable existing means the
 *    App is installed (and an interrupted run leaves the gate skipping with
 *    its notice rather than failing every PR red).
 * 6. Applies the ruleset (github:rules) so `review-record` is required, or
 *    explains why GitHub will not enforce it on this repository.
 *
 * Idempotent: when the id variable and the key secret both exist it reports
 * and stops (`--force` creates a new App). Agents never run it.
 */
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sessionIsAgent } from './agent-session';
import { openInBrowser } from './browser';
import {
  APP_ID_VARIABLE,
  APP_KEY_SECRET,
  REVIEW_ENVIRONMENT,
  alreadySetUp,
  appJwt,
  appName,
  appSlug,
  branchPolicyArgs,
  buildManifest,
  CALLBACK_DONE_PAGE,
  conversionArgs,
  ENVIRONMENT_BODY,
  environmentArgs,
  installUrl,
  manifestFormUrl,
  manifestPage,
  nameProblem,
  ownerType,
  parseCallback,
  parseConversion,
  reviewAppSteps,
  rulesetDecision,
  secretSetArgs,
  variableSetArgs,
  type Conversion,
} from './github-review-app-plan';
import {
  ghFailure,
  renderRepositoryConfig,
  rulesetsUnavailableMessage,
  runGithubRules,
  type GhResult,
  type RepositoryPolicy,
} from './github-rules';
import { loadProjectConfig } from './project-config';

const CALLBACK_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INSTALL_POLL_MS = 3_000;

/** gh with optional stdin; injected so the tests never reach GitHub. */
export type GhIn = (args: readonly string[], stdin?: string) => GhResult;

export type ManifestSession = {
  /** The local page to open; it posts the manifest to GitHub. */
  readonly localUrl: string;
  /** GitHub's code once its redirect carries this run's state. */
  readonly code: Promise<string>;
  readonly stop: () => void;
};

export type ReviewAppDeps = {
  readonly gh: GhIn;
  readonly open: (url: string) => void;
  readonly log: (line: string) => void;
  /** Serves the manifest page for `page(port)` and waits for the callback. */
  readonly serve: (input: {
    readonly page: (port: number) => string;
    readonly state: string;
    readonly timeoutMs: number;
  }) => ManifestSession;
  /** GET an api.github.com path as the App; resolves to the HTTP status. */
  readonly appGet: (path: string, jwt: string) => Promise<number>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  readonly randomHex: (bytes: number) => string;
  /** `bun github:rules --apply`; returns its exit code. */
  readonly applyRules: () => number;
};

export type ReviewAppInput = {
  readonly repository: string;
  readonly name?: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly autonomous: boolean;
};

const ok = (result: GhResult) => result.code === 0;

function ghOrThrow(
  deps: ReviewAppDeps,
  args: readonly string[],
  stdin?: string,
) {
  const result = deps.gh(args, stdin);
  if (!ok(result)) throw new Error(ghFailure(args, result.stderr));
  return result.stdout;
}

/** Which of the id and the key an earlier run stored. */
function storedState(deps: ReviewAppDeps, repository: string) {
  const repo = `repos/${repository}`;
  return {
    variable: ok(
      deps.gh(['api', `${repo}/actions/variables/${APP_ID_VARIABLE}`]),
    ),
    secret:
      ok(
        deps.gh([
          'api',
          `${repo}/environments/${REVIEW_ENVIRONMENT}/secrets/${APP_KEY_SECRET}`,
        ]),
      ) || ok(deps.gh(['api', `${repo}/actions/secrets/${APP_KEY_SECRET}`])),
  };
}

/** The App name: --name, else `<repo>-review-record`, tagged when taken. */
function chooseName(deps: ReviewAppDeps, input: ReviewAppInput): string {
  if (input.name) return input.name;
  const plain = appName(input.repository.split('/')[1] ?? '');
  const taken = ok(deps.gh(['api', `apps/${appSlug(plain)}`]));
  return taken
    ? appName(input.repository.split('/')[1] ?? '', deps.randomHex(2))
    : plain;
}

async function createApp(
  deps: ReviewAppDeps,
  input: ReviewAppInput,
  name: string,
  formUrl: (state: string) => string,
): Promise<Conversion> {
  const state = deps.randomHex(16);
  const session = deps.serve({
    state,
    timeoutMs: CALLBACK_TIMEOUT_MS,
    page: (port) =>
      manifestPage(
        formUrl(state),
        buildManifest({ repository: input.repository, name, port }),
      ),
  });
  deps.log(
    `\nClick 1 of 2: your browser opens GitHub with the App "${name}" filled in.`,
  );
  deps.log('Check it, then click "Create GitHub App".');
  deps.log(`  If the browser does not open, visit ${session.localUrl}`);
  deps.open(session.localUrl);
  let code: string;
  try {
    code = await session.code;
  } finally {
    session.stop();
  }
  return parseConversion(ghOrThrow(deps, conversionArgs(code)));
}

/** Restricts the environment to main and stores the key; returns where it went. */
/** Whether main may deploy to the environment (created now or earlier). */
function mainOnly(deps: ReviewAppDeps, repository: string): boolean {
  if (ok(deps.gh(branchPolicyArgs(repository)))) return true;
  const existing = deps.gh([
    'api',
    `repos/${repository}/environments/${REVIEW_ENVIRONMENT}/deployment-branch-policies`,
    '--jq',
    '.branch_policies[].name',
  ]);
  return ok(existing) && existing.stdout.split('\n').includes('main');
}

/** Restricts the environment to main and stores the key; returns where it went. */
function storeKey(
  deps: ReviewAppDeps,
  repository: string,
  pem: string,
): string {
  const environment =
    ok(deps.gh(environmentArgs(repository), ENVIRONMENT_BODY)) &&
    mainOnly(deps, repository);
  if (!environment)
    deps.log(
      `  The ${REVIEW_ENVIRONMENT} environment could not be limited to main (environments on a private repository need a paid plan), so the key is a repository secret: any workflow on any branch could read it. Make the repository public or upgrade, then rerun with --force.`,
    );
  ghOrThrow(deps, secretSetArgs(repository, environment), pem);
  return environment
    ? `the ${REVIEW_ENVIRONMENT} environment`
    : 'the repository';
}

async function waitForInstall(
  deps: ReviewAppDeps,
  repository: string,
  app: Conversion,
): Promise<boolean> {
  const url = installUrl(app.slug);
  deps.log(`\nClick 2 of 2: install the App on ${repository} only.`);
  deps.log(`  If the browser does not open, visit ${url}`);
  deps.open(url);
  const deadline = deps.nowMs() + INSTALL_TIMEOUT_MS;
  while (deps.nowMs() < deadline) {
    const jwt = appJwt(app.id, app.pem, Math.floor(deps.nowMs() / 1000));
    if ((await deps.appGet(`/repos/${repository}/installation`, jwt)) === 200)
      return true;
    await deps.sleep(INSTALL_POLL_MS);
  }
  return false;
}

/** Requires review-record in the ruleset, or explains why GitHub will not. */
function enforce(deps: ReviewAppDeps, repository: string): number {
  const visibility = deps.gh([
    'api',
    `repos/${repository}`,
    '--jq',
    '.visibility',
  ]);
  const plan = deps.gh(['api', 'user', '--jq', '.plan.name']);
  const planName = ok(plan) ? plan.stdout.trim() || null : null;
  if (rulesetDecision(visibility.stdout.trim(), planName) === 'unavailable') {
    deps.log(
      `\n${rulesetsUnavailableMessage(repository, planName ?? undefined)}`,
    );
    return 0;
  }
  deps.log('\nRequiring review-record on main: bun github:rules --apply');
  return deps.applyRules();
}

/** The whole setup; returns a process exit code. */
export async function setupReviewApp(
  input: ReviewAppInput,
  deps: ReviewAppDeps,
): Promise<number> {
  if (input.autonomous) {
    deps.log(
      'Agents never create GitHub Apps; the owner runs bun github:review-app.',
    );
    return 1;
  }
  const problem = input.name === undefined ? null : nameProblem(input.name);
  if (problem) {
    deps.log(`--name ${problem}`);
    return 2;
  }
  const { repository } = input;
  if (!input.force && alreadySetUp(storedState(deps, repository))) {
    deps.log(
      `review-record App already set up on ${repository} (${APP_ID_VARIABLE} and ${APP_KEY_SECRET} exist); nothing to do. Use --force to create a new App.`,
    );
    return 0;
  }
  const owner = repository.split('/')[0] ?? '';
  const ownerResult = deps.gh(['api', `users/${owner}`, '--jq', '.type']);
  const type = ownerType(ownerResult.code, ownerResult.stdout);
  if (type === null) {
    deps.log(ghFailure(['api', `users/${owner}`], ownerResult.stderr));
    return 1;
  }
  const name = chooseName(deps, input);
  const formUrl = (state: string) => manifestFormUrl(owner, type, state);
  if (input.dryRun) {
    deps.log(`github:review-app ${repository} (dry run):`);
    reviewAppSteps({ repository, name, formUrl: formUrl('<random>') }).forEach(
      (step, index) => deps.log(`  ${index + 1}. ${step}`),
    );
    return 0;
  }
  const app = await createApp(deps, input, name, formUrl);
  deps.log(`  Created ${app.htmlUrl} (App id ${app.id}).`);
  deps.log(
    `  Stored its private key in ${storeKey(deps, repository, app.pem)}.`,
  );
  if (!(await waitForInstall(deps, repository, app))) {
    deps.log(
      `\nThe App is not installed on ${repository} yet. Install it at ${installUrl(app.slug)}, then run:\n  gh ${variableSetArgs(repository, app.id).join(' ')}\n  bun github:rules --apply`,
    );
    return 1;
  }
  ghOrThrow(deps, variableSetArgs(repository, app.id));
  deps.log(`  Installed; ${APP_ID_VARIABLE}=${app.id} is set.`);
  return enforce(deps, repository);
}

// ------------------------------------------------------------------- edges

const realGh: GhIn = (args, stdin) => {
  const result = Bun.spawnSync(['gh', ...args], {
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

/** The one-shot 127.0.0.1 server: `/` posts the manifest, `/callback` takes the code. */
export const serveManifest: ReviewAppDeps['serve'] = ({
  page,
  state,
  timeoutMs,
}) => {
  let settle:
    | { resolve: (code: string) => void; reject: (error: Error) => void }
    | undefined;
  const code = new Promise<string>((resolvePromise, reject) => {
    settle = { resolve: resolvePromise, reject };
  });
  let html = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      };
      if (url.pathname === '/') return new Response(html, { headers });
      const result = parseCallback(url, state);
      if ('error' in result)
        return new Response(`Refused: ${result.error}.`, { status: 400 });
      settle?.resolve(result.code);
      return new Response(CALLBACK_DONE_PAGE, { headers });
    },
  });
  const port = server.port ?? 0;
  html = page(port);
  const timer = setTimeout(
    () =>
      settle?.reject(
        new Error(
          `GitHub did not redirect back within ${timeoutMs / 60_000} minutes. Nothing was stored; run bun github:review-app again (delete any half-made App at https://github.com/settings/apps).`,
        ),
      ),
    timeoutMs,
  );
  return {
    localUrl: `http://127.0.0.1:${port}/`,
    code,
    stop: () => {
      clearTimeout(timer);
      // Graceful: the callback's "return to your terminal" page still reaches the browser.
      void server.stop();
    },
  };
};

const appGet: ReviewAppDeps['appGet'] = async (path, jwt) => {
  try {
    const response = await fetch(new URL(path, 'https://api.github.com'), {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return response.status;
  } catch {
    return 0;
  }
};

const USAGE =
  'Usage: bun github:review-app [--name <app name>] [--dry-run] [--force]';

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      name: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const project = loadProjectConfig(root);
  const rules = renderRepositoryConfig(
    (await Bun.file(
      join(root, 'policy/github/repository.json'),
    ).json()) as RepositoryPolicy,
    project,
  );
  const log = (line: string) => process.stdout.write(`${line}\n`);
  process.exit(
    await setupReviewApp(
      {
        repository: project.repo,
        name: values.name,
        dryRun: values['dry-run'],
        force: values.force,
        autonomous: sessionIsAgent(process.env),
      },
      {
        gh: realGh,
        open: openInBrowser,
        log,
        serve: serveManifest,
        appGet,
        sleep: (ms) => Bun.sleep(ms),
        nowMs: () => Date.now(),
        randomHex: (bytes) => randomBytes(bytes).toString('hex'),
        applyRules: () =>
          runGithubRules({
            config: rules,
            gh: realGh,
            apply: true,
            autonomous: false,
            out: (text) => process.stdout.write(text),
            err: (text) => process.stderr.write(text),
          }),
      },
    ),
  );
}

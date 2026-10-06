/**
 * Pure planning for `bun github:review-app`: the review-record GitHub App's
 * manifest, the manifest form page, the callback check, the App JWT, the gh
 * commands that store its id and key, and the dry-run plan. No I/O; the
 * script (github-review-app.ts) and the wizard (cli/wizard-review-app.ts)
 * both read these, so the plan they show is the plan that runs.
 *
 * Flow (GitHub's App manifest flow): a local page posts the manifest to
 * GitHub, the owner clicks "Create GitHub App" (click 1), GitHub redirects
 * to 127.0.0.1 with a one-hour code, `POST /app-manifests/{code}/conversions`
 * returns the id, slug and private key, the owner installs the App on the
 * repository (click 2), and only then is REVIEW_RECORD_APP_ID set.
 */
import { sign } from 'node:crypto';

export const APP_ID_VARIABLE = 'REVIEW_RECORD_APP_ID';
export const APP_KEY_SECRET = 'REVIEW_RECORD_APP_KEY';
/** The Actions environment review-record.yml's jobs run in (main only). */
export const REVIEW_ENVIRONMENT = 'review-record';

/**
 * Exactly what the App's installation token is used for, and nothing more.
 * review-record.yml mints the token with these same three permissions
 * (`permission-*` on actions/create-github-app-token); minting fails if the
 * App lacks one, and any extra one would be unused authority.
 */
const REVIEW_APP_PERMISSIONS = {
  // scripts/review-record.ts: POST repos/{repo}/statuses/{sha} sets the
  // `review-record` commit status the ruleset requires from this App.
  statuses: 'write',
  // scripts/review-record-io.ts: GET repos/{repo}/pulls/{n} reads the
  // live head SHA and the body's Builder: line.
  pull_requests: 'read',
  // scripts/review-record-io.ts: GET repos/{repo}/issues/{n}/comments reads
  // the PR comments that link the review record.
  issues: 'read',
  // Granted to every App; listed so the manifest states it explicitly.
  metadata: 'read',
} as const;

/** GitHub's limit on an App name. */
const APP_NAME_MAX = 34;
const APP_NAME_SUFFIX = '-review-record';

const trimHyphens = (text: string): string =>
  text.replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * `<repo>-review-record`, the repository part cut so the whole stays within
 * 34 characters; `tag` (a few random hex digits) makes a taken name unique.
 */
export function appName(repoName: string, tag?: string): string {
  const tail = `${tag ? `-${tag}` : ''}${APP_NAME_SUFFIX}`;
  const base = trimHyphens(
    repoName.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
  ).slice(0, APP_NAME_MAX - tail.length);
  return `${trimHyphens(base)}${tail}`;
}

/** The slug GitHub derives from an App name. */
export const appSlug = (name: string): string =>
  trimHyphens(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

export const nameProblem = (name: string): string | null =>
  name.length === 0 || name.length > APP_NAME_MAX
    ? `must be 1 to ${APP_NAME_MAX} characters`
    : appSlug(name) === ''
      ? 'needs at least one letter or digit'
      : null;

export type Manifest = {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly hook_attributes: { readonly url: string; readonly active: false };
  readonly redirect_url: string;
  readonly public: false;
  readonly default_permissions: typeof REVIEW_APP_PERMISSIONS;
  readonly default_events: readonly [];
};

const callbackUrl = (port: number): string =>
  `http://127.0.0.1:${port}/callback`;

/** The App manifest: private, no webhook, only the workflow's permissions. */
export function buildManifest(input: {
  readonly repository: string;
  readonly name: string;
  readonly port: number;
}): Manifest {
  const url = `https://github.com/${input.repository}`;
  return {
    name: input.name,
    url,
    description: `Sets the review-record merge gate on ${input.repository} from independent review records.`,
    // GitHub requires a hook URL; inactive, it never receives a delivery.
    hook_attributes: { url, active: false },
    redirect_url: callbackUrl(input.port),
    public: false,
    default_permissions: REVIEW_APP_PERMISSIONS,
    default_events: [],
  };
}

export type OwnerType = 'User' | 'Organization';

/** `gh api users/<owner> --jq .type` output as an owner type, or null. */
export const ownerType = (code: number, stdout: string): OwnerType | null => {
  const type = stdout.trim();
  return code === 0 && (type === 'User' || type === 'Organization')
    ? type
    : null;
};

/**
 * Where the manifest is posted: the user's or the organization's App
 * settings. The state is this run's random hex (URL-safe as it is).
 */
export function manifestFormUrl(
  owner: string,
  type: OwnerType,
  state: string,
): string {
  const base =
    type === 'Organization'
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : 'https://github.com/settings/apps/new';
  return `${base}?state=${state}`;
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/** The local page that posts the manifest to GitHub as soon as it loads. */
export function manifestPage(action: string, manifest: Manifest): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create the review-record App</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Sending you to GitHub to create <strong>${escapeHtml(manifest.name)}</strong>&hellip;</p>
<button type="submit">Continue to GitHub</button>
</form>
</body>
</html>
`;
}

export const CALLBACK_DONE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title></head>' +
  '<body><p>The review-record App was created. Return to your terminal.</p></body></html>';

export type CallbackResult =
  { readonly code: string } | { readonly error: string };

/**
 * GitHub's redirect after "Create GitHub App": the code, only when the
 * state matches the one this run sent (anything else is not our request).
 */
export function parseCallback(url: URL, expectedState: string): CallbackResult {
  if (url.pathname !== '/callback') return { error: 'not the callback path' };
  const state = url.searchParams.get('state');
  if (state !== expectedState)
    return { error: 'the state does not match this setup run' };
  const code = url.searchParams.get('code') ?? '';
  return /^[A-Za-z0-9_-]{1,100}$/.test(code)
    ? { code }
    : { error: 'GitHub sent no usable code' };
}

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64url');

/**
 * A GitHub App JWT (RS256): issued a minute in the past for clock drift,
 * expiring nine minutes later (GitHub's limit is ten).
 */
export function appJwt(
  appId: number,
  privateKeyPem: string,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: String(appId),
    }),
  );
  const signed = `${header}.${payload}`;
  return `${signed}.${base64url(sign('sha256', Buffer.from(signed), privateKeyPem))}`;
}

export type Conversion = {
  readonly id: number;
  readonly slug: string;
  readonly pem: string;
  readonly htmlUrl: string;
};

/** The conversion response, or an error that never quotes the body (it holds the key). */
export function parseConversion(stdout: string): Conversion {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error('GitHub answered the manifest conversion with non-JSON');
  }
  const { id, slug, pem, html_url: htmlUrl } = body;
  if (
    typeof id !== 'number' ||
    typeof slug !== 'string' ||
    typeof pem !== 'string' ||
    !pem.includes('PRIVATE KEY') ||
    typeof htmlUrl !== 'string'
  )
    throw new Error(
      'GitHub answered the manifest conversion without an id, slug, key and URL',
    );
  return { id, slug, pem, htmlUrl };
}

export const installUrl = (slug: string): string =>
  `https://github.com/apps/${slug}/installations/new`;

// --------------------------------------------------------------- commands

export const conversionArgs = (code: string): readonly string[] => [
  'api',
  '-X',
  'POST',
  `app-manifests/${code}/conversions`,
];

/** Body for PUT repos/{repo}/environments/review-record: main deploys only. */
export const ENVIRONMENT_BODY = JSON.stringify({
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
});

export const environmentArgs = (repository: string): readonly string[] => [
  'api',
  '-X',
  'PUT',
  `repos/${repository}/environments/${REVIEW_ENVIRONMENT}`,
  '--input',
  '-',
];

export const branchPolicyArgs = (repository: string): readonly string[] => [
  'api',
  '-X',
  'POST',
  `repos/${repository}/environments/${REVIEW_ENVIRONMENT}/deployment-branch-policies`,
  '-f',
  'name=main',
  '-f',
  'type=branch',
];

/** The key goes on stdin; it never appears in argv. */
export const secretSetArgs = (
  repository: string,
  environment: boolean,
): readonly string[] => [
  'secret',
  'set',
  APP_KEY_SECRET,
  ...(environment ? ['--env', REVIEW_ENVIRONMENT] : []),
  '-R',
  repository,
];

export const variableSetArgs = (
  repository: string,
  appId: number | string,
): readonly string[] => [
  'variable',
  'set',
  APP_ID_VARIABLE,
  '--body',
  String(appId),
  '-R',
  repository,
];

/** Whether an earlier run finished: the id is set only once the App is installed. */
export const alreadySetUp = (state: {
  readonly variable: boolean;
  readonly secret: boolean;
}): boolean => state.variable && state.secret;

export type RulesetDecision = 'apply' | 'unavailable';

/**
 * GitHub enforces rulesets on public repositories, and on private ones only
 * on a paid plan; an unknown plan is tried (github:rules explains a 403).
 */
export const rulesetDecision = (
  visibility: string,
  plan: string | null,
): RulesetDecision =>
  visibility === 'public' || plan !== 'free' ? 'apply' : 'unavailable';

/** Every step, in order, as the dry run (script or wizard) shows it. */
export function reviewAppSteps(input: {
  readonly repository: string;
  readonly name: string;
  readonly formUrl: string;
}): string[] {
  const repo = input.repository;
  const slug = appSlug(input.name);
  const permissions = Object.entries(REVIEW_APP_PERMISSIONS)
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
  return [
    `serve http://127.0.0.1:<free port>/ and open it: it posts the manifest for "${input.name}" (private, no webhook, ${permissions}) to ${input.formUrl}`,
    'you click "Create GitHub App" on GitHub (click 1 of 2); GitHub redirects to http://127.0.0.1:<port>/callback?code=…&state=… (state checked)',
    `$ gh ${conversionArgs('<code>').join(' ')}   (the private key stays in memory, never printed)`,
    `$ gh ${environmentArgs(repo).join(' ')}   (deployments from main only)`,
    `$ gh ${branchPolicyArgs(repo).join(' ')}`,
    `$ gh ${secretSetArgs(repo, true).join(' ')}   (the key on stdin)`,
    `open ${installUrl(slug)}: you install it on ${repo} (click 2 of 2)`,
    `poll GET /repos/${repo}/installation as the App (RS256 JWT) until it is installed`,
    `$ gh ${variableSetArgs(repo, '<app id>').join(' ')}`,
    `$ bun github:rules --apply   (when ${repo} is public or the plan has rulesets; otherwise explain why the gate is not enforced)`,
  ];
}

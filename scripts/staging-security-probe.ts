#!/usr/bin/env bun
/**
 * AUTH-7.8: non-mutating live proof of staging ingress and cookie security
 * against the deployed app (never a local fixture). Every probe here is a
 * GET, or a POST whose Origin/Sec-Fetch-Site is deliberately wrong so the
 * request is refused before any handler reads the body — `requireSameOrigin`
 * / `requireSameOriginForm` (apps/web/src/server/http.ts) run first, so
 * nothing here ever sends an email, creates a session, or touches an
 * account. It never creates a session, so it cannot prove Set-Cookie
 * attributes on the actual session cookie; that is covered statically (see
 * the AUTH-7.8 handoff) and needs a signed-in probe only if the owner asks
 * for one.
 *
 *   bun scripts/staging-security-probe.ts [--url https://offense-demo-staging.fly.dev]
 *
 * Exits non-zero and prints every failing check if any probe fails; prints
 * NOT RUN with a reason for a check this script cannot perform from outside
 * Fly's network (the trusted-IP correlation needs `fly logs`, which needs an
 * authenticated flyctl session).
 */
export type ProbeResponse = {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
};

const header = (response: ProbeResponse, name: string) =>
  response.headers.get(name.toLowerCase()) ?? null;

/** AC2 bullet 2: plaintext HTTP must redirect to HTTPS, never serve. */
export function httpsRedirectIssues(
  response: ProbeResponse,
): readonly string[] {
  const issues: string[] = [];
  if (response.status < 300 || response.status >= 400)
    issues.push(
      `plaintext HTTP answered ${response.status} instead of redirecting`,
    );
  const location = header(response, 'location');
  if (location !== null && !location.startsWith('https://'))
    issues.push(`redirect Location "${location}" is not HTTPS`);
  return issues;
}

/**
 * AC2 bullet 5: a credentialed wildcard is `Access-Control-Allow-Origin: *`
 * together with `Access-Control-Allow-Credentials: true`, or an ACAO that
 * echoes back an arbitrary cross-site Origin while allowing credentials.
 * Offense Demo sets no CORS headers at all (same-origin only), which also passes.
 */
export function corsIssues(
  response: ProbeResponse,
  requestOrigin: string,
): readonly string[] {
  const allowOrigin = header(response, 'access-control-allow-origin');
  const allowCredentials = header(response, 'access-control-allow-credentials');
  if (allowOrigin === null) return [];
  const issues: string[] = [];
  if (allowOrigin === '*' && allowCredentials === 'true')
    issues.push(
      'Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true',
    );
  if (allowOrigin === requestOrigin && allowCredentials === 'true')
    issues.push(
      `Access-Control-Allow-Origin echoes an arbitrary cross-site Origin (${requestOrigin}) with credentials allowed`,
    );
  return issues;
}

/** AC2 bullet 6: an account/session response must never be shared-cacheable. */
export function noSharedCacheIssues(
  response: ProbeResponse,
): readonly string[] {
  const cacheControl = (header(response, 'cache-control') ?? '').toLowerCase();
  const issues: string[] = [];
  if (!cacheControl.includes('no-store'))
    issues.push(`Cache-Control "${cacheControl || '(absent)'}" lacks no-store`);
  if (cacheControl.includes('public') || /s-maxage=(?!0)\d/.test(cacheControl))
    issues.push(`Cache-Control "${cacheControl}" permits shared caching`);
  return issues;
}

/** AC2 bullet 4: a cross-origin state change must be refused, not processed. */
export function originEnforcementIssues(
  response: ProbeResponse,
): readonly string[] {
  return response.status === 401 || response.status === 403
    ? []
    : [`cross-origin POST answered ${response.status} instead of 401/403`];
}

/**
 * AC2 bullet 1: the ingress must resolve one real client identity
 * regardless of what a caller forges in X-Forwarded-For or Fly-Client-IP.
 * `hashes` is every `clientIdHash` a matching `http.request.completed` log
 * line carried for requests sent within the same probe run (see `main`).
 */
export function clientIpTrustIssues(
  hashes: readonly string[],
): readonly string[] {
  const distinct = new Set(hashes);
  if (distinct.size > 1)
    return [
      `${distinct.size} distinct clientIdHash values across forged-header requests; the ingress trusted a caller-supplied header`,
    ];
  return [];
}

/**
 * AC2 bullet 3: HttpOnly, Secure, SameSite, and a host-only (no explicit
 * Domain) scope narrower than the whole site. Parses one Set-Cookie line.
 */
export function cookieAttributeIssues(setCookie: string): readonly string[] {
  const attributes = setCookie.split(';').map((part) => part.trim());
  const [nameValue = ''] = attributes;
  const name = nameValue.split('=')[0] ?? '';
  const lower = attributes.map((attribute) => attribute.toLowerCase());
  const issues: string[] = [];
  if (!lower.includes('httponly')) issues.push(`${name}: missing HttpOnly`);
  if (!lower.includes('secure')) issues.push(`${name}: missing Secure`);
  if (!lower.some((attribute) => attribute.startsWith('samesite=')))
    issues.push(`${name}: missing SameSite`);
  if (lower.some((attribute) => attribute.startsWith('domain=')))
    issues.push(`${name}: sets Domain (should be host-only)`);
  if (
    !attributes.some((attribute) => attribute.toLowerCase().startsWith('path='))
  )
    issues.push(`${name}: missing Path`);
  return issues;
}

type CheckResult =
  | { readonly status: 'PASS' }
  | { readonly status: 'FAIL'; readonly issues: readonly string[] }
  | { readonly status: 'NOT RUN'; readonly reason: string };

const toMap = (headers: Headers): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  headers.forEach((value, key) => map.set(key.toLowerCase(), value));
  return map;
};

async function probe(
  url: string,
  init: RequestInit = {},
): Promise<ProbeResponse> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  return { status: response.status, headers: toMap(response.headers) };
}

/** Best-effort: only present when this machine has an authenticated flyctl session. */
function recentFlyLogLines(app: string): readonly string[] | null {
  const result = Bun.spawnSync(['fly', 'logs', '-a', app, '--no-tail'], {
    timeout: 15_000,
  });
  return result.exitCode === 0 ? result.stdout.toString().split('\n') : null;
}

/**
 * Correlates by the exact `x-request-id` each probe response carried
 * (`handleOperation` stamps it), never by a time window: Fly's own 15s
 * readiness checker also calls `/api/health/ready` and would otherwise
 * pollute the sample with a request this script never sent.
 */
function clientIdHashesForRequestIds(
  lines: readonly string[],
  requestIds: readonly string[],
): readonly string[] {
  const byRequestId = new Map<string, string>();
  for (const line of lines) {
    if (!line.includes('"event":"http.request.completed"')) continue;
    const requestId = line.match(/"requestId":"([^"]+)"/)?.[1];
    const hash = line.match(/"clientIdHash":"([0-9a-f]+)"/)?.[1];
    if (requestId && hash) byRequestId.set(requestId, hash);
  }
  return requestIds
    .map((id) => byRequestId.get(id))
    .filter((hash): hash is string => hash !== undefined);
}

/**
 * AC3: no PostgreSQL/Redis connection string, credentialed URL, or the
 * secret env var names themselves may ever reach a log line, whatever
 * caused it to be written.
 */
export const SECRET_LEAK_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/\S*:\S*@/i,
  /redis:\/\/\S*:\S*@/i,
  /\bMIGRATION_DATABASE_URL\b/,
  /\bDATABASE_URL\b/,
  /\bBETTER_AUTH_SECRET\b/,
  /\bRECIPIENT_HASH_SECRET\b/,
  /\bRESEND_API_KEY\b/,
  /\bRESEND_WEBHOOK_SECRET\b/,
];

export function secretLeakIssues(lines: readonly string[]): readonly string[] {
  const hits = lines.filter((line) =>
    SECRET_LEAK_PATTERNS.some((pattern) => pattern.test(line)),
  );
  return hits.length === 0
    ? []
    : [`${hits.length} log line(s) carry a secret-bearing pattern`];
}

const fromIssues = (issues: readonly string[]): CheckResult =>
  issues.length === 0 ? { status: 'PASS' } : { status: 'FAIL', issues };

const notRun = (reason: string): CheckResult => ({ status: 'NOT RUN', reason });

async function runChecks(
  url: string,
  app: string,
): Promise<Map<string, CheckResult>> {
  const httpUrl = `http://${new URL(url).hostname}/`;
  const results = new Map<string, CheckResult>();

  results.set(
    'HTTPS redirect',
    fromIssues(httpsRedirectIssues(await probe(httpUrl))),
  );

  const sessionRead = await probe(`${url}/api/auth/get-session`, {
    headers: { origin: 'https://evil.example' },
  });
  results.set(
    'No credentialed wildcard CORS',
    fromIssues(corsIssues(sessionRead, 'https://evil.example')),
  );
  results.set(
    'No shared caching of account responses',
    fromIssues(noSharedCacheIssues(sessionRead)),
  );

  const crossOriginPost = await probe(`${url}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: 'staging-security-probe@example.invalid' }),
  });
  results.set(
    'CSRF / origin enforcement (cross-origin state change)',
    fromIssues(originEnforcementIssues(crossOriginPost)),
  );

  const originNull = await probe(`${url}/auth/confirm`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: '',
  });
  results.set(
    'CSRF / origin enforcement (Origin: null without Sec-Fetch-Site: same-origin)',
    fromIssues(originEnforcementIssues(originNull)),
  );

  const forgedHeaders = [
    {},
    { 'x-forwarded-for': '203.0.113.9' },
    { 'x-forwarded-for': '198.51.100.7' },
    { 'fly-client-ip': '203.0.113.9' },
    { 'fly-client-ip': '198.51.100.7' },
  ];
  const requestIds: string[] = [];
  for (const headers of forgedHeaders) {
    const probed = await probe(`${url}/api/health/ready`, { headers });
    const requestId = probed.headers.get('x-request-id');
    if (requestId) requestIds.push(requestId);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const logLines = recentFlyLogLines(app);
  const noFlySession = notRun(
    'no authenticated flyctl session (`fly logs` unavailable)',
  );
  if (logLines === null) {
    results.set(
      'Trusted client-IP handling (Fly-Client-IP, forged headers ignored)',
      noFlySession,
    );
    results.set(
      'No secret-bearing query strings in ingress/application logs',
      noFlySession,
    );
  } else {
    const hashes = clientIdHashesForRequestIds(logLines, requestIds);
    results.set(
      'Trusted client-IP handling (Fly-Client-IP, forged headers ignored)',
      hashes.length < forgedHeaders.length
        ? notRun('`fly logs` had not yet delivered every probe’s line')
        : fromIssues(clientIpTrustIssues(hashes)),
    );
    results.set(
      'No secret-bearing query strings in ingress/application logs',
      fromIssues(secretLeakIssues(logLines)),
    );
  }

  results.set(
    'Cookie attributes (HttpOnly/Secure/SameSite/host+path scope)',
    notRun(
      'no non-mutating request sets a cookie; needs a signed-in probe (see AUTH-7.8 handoff)',
    ),
  );

  return results;
}

function report(results: ReadonlyMap<string, CheckResult>): boolean {
  let failed = false;
  for (const [name, result] of results) {
    if (result.status === 'PASS') process.stdout.write(`PASS  ${name}\n`);
    else if (result.status === 'NOT RUN')
      process.stdout.write(`NOT RUN  ${name}: ${result.reason}\n`);
    else {
      failed = true;
      process.stdout.write(`FAIL  ${name}\n`);
      for (const issue of result.issues)
        process.stdout.write(`      - ${issue}\n`);
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const flagIndex = process.argv.indexOf('--url');
  const url =
    flagIndex === -1
      ? 'https://offense-demo-staging.fly.dev'
      : process.argv[flagIndex + 1];
  if (!url)
    throw new Error(
      'usage: bun scripts/staging-security-probe.ts [--url https://...]',
    );
  const app = new URL(url).hostname.replace(/\.fly\.dev$/, '');
  const failed = report(await runChecks(url, app));
  if (failed) process.exit(1);
}

if (import.meta.main) await main();

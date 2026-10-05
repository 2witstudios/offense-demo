#!/usr/bin/env bun
/**
 * AUTH-7.7's alert evaluation point. Nothing running inside the app can
 * alert on its own unavailability while it is down, restarting or
 * crash-looping, even though staging is always on (DEC-40, `fly.toml`'s
 * `min_machines_running = 1`). This script runs outside the app instead
 * (the scheduled `auth-alerts.yml` GitHub Actions workflow — configured for
 * every 5 minutes, though GitHub's schedule trigger does not actually run
 * that often in production; the owner accepted this best-effort cadence
 * for staging rather than build a new scheduler, see ADR 0046/DEC-33) and:
 *
 *   1. probes the public origin's readiness endpoint — one non-mutating
 *      GET, proving routing (a 200 from the expected host), TLS (the fetch
 *      completing at all against an `https://` URL: an invalid or expired
 *      certificate throws before a status ever comes back) and the
 *      security-header contract `next.config.ts` sets on every response;
 *   2. reads the already-evaluated conditions from the bearer-token gated
 *      `/api/ops/alerts` (`evaluateAlerts` in
 *      `apps/web/src/server/alert-state.ts` runs server-side, so this
 *      script never reimplements a threshold — there is exactly one place
 *      each one lives);
 *   3. posts whatever fired to the drive's Incidents channel via the
 *      existing `scripts/notify-drive.ts incidents --message`.
 *
 * It never ends without posting when something is wrong (ISSUE-208,
 * ISSUE-209): every request has a budget (`PROBE_FETCH_TIMEOUT_MS`, and
 * `NOTIFY_ATTEMPT_TIMEOUT_MS` in notify-drive.ts) that fits well inside the
 * workflow's 5-minute job limit, a body it cannot validate is an unreadable
 * alert state, and anything that throws still posts before exiting 1.
 *
 *   OPS_PROBE_TOKEN=<token> bun --no-install scripts/auth-alert-probe.ts \
 *     --origin https://offense-demo.example.com [--run-url <workflow run URL>]
 */
import type { AlertCondition } from '../apps/web/src/server/alert-state';

/** `auth-alerts.yml`'s `timeout-minutes: 5`: GitHub kills the job after this. */
export const PROBE_JOB_LIMIT_MS = 5 * 60_000;

/**
 * Each of the probe's two requests (readiness, then `/api/ops/alerts`) is
 * abandoned after this long, headers and body together, and counts as a
 * failed request, so a hung origin still ends in a post (ISSUE-208).
 */
export const PROBE_FETCH_TIMEOUT_MS = 20_000;

/** The fixed header contract `apps/web/next.config.ts` sets for every response. */
export const REQUIRED_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export type OriginProbeResult = {
  readonly ok: boolean;
  readonly issues: readonly string[];
};

/**
 * Pure: given the readiness response's already-read status and headers,
 * proves routing (an expected 200) and the security-header contract. TLS
 * itself is proven by the caller's `fetch` completing at all against an
 * `https://` URL — an invalid certificate never reaches this function.
 * Headers are checked only on a 200. Any other status is one issue, not one
 * per missing header (ISSUE-196): with the app's headers it is the app
 * reporting itself not ready (ISSUE-203); without them it most likely came
 * from the edge proxy or start-up gate rather than Next.
 */
export function evaluateOriginProbe(input: {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}): OriginProbeResult {
  if (input.status !== 200) {
    const fromApp = Object.keys(REQUIRED_SECURITY_HEADERS).some((name) =>
      input.headers.has(name),
    );
    const cause = fromApp
      ? 'the app reported not ready (dependency down or draining)'
      : 'the response likely did not come from the app (cold start, start-up gate, or app down)';
    return {
      ok: false,
      issues: [`readiness answered ${input.status}, not 200; ${cause}`],
    };
  }
  const issues: string[] = [];
  for (const [name, expected] of Object.entries(REQUIRED_SECURITY_HEADERS)) {
    const actual = input.headers.get(name);
    if (actual !== expected)
      issues.push(`${name}: expected "${expected}", got ${actual ?? 'none'}`);
  }
  return { ok: issues.length === 0, issues };
}

async function readHeaders(response: Response): Promise<Map<string, string>> {
  const headers = new Map<string, string>();
  for (const [name, value] of response.headers) headers.set(name, value);
  return headers;
}

/**
 * Fetches `/api/health/ready` and evaluates it. Never throws: an origin
 * that cannot be reached at all (DNS failure, TLS failure, connection
 * refused) is itself an origin-probe issue, modeled without ever
 * constructing a placeholder `Response` — `Response` refuses a status
 * outside 101/200-599 (`new Response(null, { status: 0 })` throws
 * `RangeError`), which previously made an unreachable origin crash `main`
 * before it could post anything (ISSUE-156).
 */
export async function fetchOriginProbe(
  origin: string,
  timeoutMs: number = PROBE_FETCH_TIMEOUT_MS,
): Promise<OriginProbeResult> {
  try {
    const response = await fetch(new URL('/api/health/ready', origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return evaluateOriginProbe({
      status: response.status,
      headers: await readHeaders(response),
    });
  } catch (error) {
    return {
      ok: false,
      issues: [`/api/health/ready request failed: ${(error as Error).message}`],
    };
  }
}

/** Pure: the Incidents message for whatever fired, naming each condition's own runbook. */
export function composeAlertMessage(input: {
  readonly conditions: readonly AlertCondition[];
  readonly originIssues: readonly string[];
  readonly runUrl?: string;
}): string {
  const lines = ['🔴 AUTH-7.7 alert probe'];
  for (const condition of input.conditions)
    lines.push(
      `- ${condition.id}: ${condition.summary} (${condition.runbook})`,
    );
  for (const issue of input.originIssues)
    lines.push(`- origin_probe: ${issue}`);
  if (input.runUrl) lines.push(input.runUrl);
  return lines.join('\n');
}

export type AlertConditionsResult =
  | {
      readonly ok: true;
      readonly conditions: readonly AlertCondition[];
      /**
       * Whether the endpoint read its Redis alert state. When it could not
       * (`snapshot.redisState` other than "read", or absent), it evaluated
       * only `limiter_unavailable` (ISSUE-191, ISSUE-199).
       */
      readonly alertStateRead: boolean;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Every condition id `evaluateAlerts` can fire. A new one must be added
 * here too; until it is, the probe reports its body as unreadable rather
 * than silently passing it through.
 */
const ALERT_CONDITION_IDS = [
  'storage_unavailable',
  'limiter_unavailable',
  'delivery_failures',
  'auth_5xx_rate',
  'cleanup_missed',
  'mail_shed',
  'network_limited',
] as const satisfies readonly AlertCondition['id'][];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isConditionId = (value: unknown): value is AlertCondition['id'] =>
  (ALERT_CONDITION_IDS as readonly unknown[]).includes(value);

/** Why one `conditions` entry is not a condition, or null when it is. */
const conditionProblem = (entry: unknown, index: number): string | null => {
  if (!isRecord(entry)) return `conditions.${index} is not an object`;
  if (!isConditionId(entry.id))
    return `conditions.${index}.id is not a known condition`;
  if (typeof entry.summary !== 'string')
    return `conditions.${index}.summary is not a string`;
  if (typeof entry.runbook !== 'string')
    return `conditions.${index}.runbook is not a string`;
  return null;
};

export type AlertsBody =
  | {
      readonly ok: true;
      readonly conditions: readonly AlertCondition[];
      readonly alertStateRead: boolean;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Pure: the `/api/ops/alerts` body the probe accepts, validated by hand so
 * the probe imports no package and runs with nothing installed (ISSUE-225).
 * Anything but an object whose `conditions` is an array of known conditions
 * is unreadable (ISSUE-209). Only an explicit `snapshot.redisState` of
 * "read" counts as a read alert state (ISSUE-199).
 */
export function parseAlertsBody(body: unknown): AlertsBody {
  if (!isRecord(body)) return { ok: false, problem: 'body is not an object' };
  if (!Array.isArray(body.conditions))
    return { ok: false, problem: 'conditions is not an array' };
  const problems = body.conditions
    .map(conditionProblem)
    .filter((problem): problem is string => problem !== null);
  if (problems.length > 0) return { ok: false, problem: problems.join('; ') };
  return {
    ok: true,
    conditions: body.conditions as readonly AlertCondition[],
    alertStateRead:
      isRecord(body.snapshot) && body.snapshot.redisState === 'read',
  };
}

/** What `/api/ops/alerts` skips while it cannot read its Redis alert state. */
const UNEVALUATED_WITHOUT_ALERT_STATE = [
  'storage_unavailable',
  'delivery_failures',
  'auth_5xx_rate',
  'cleanup_missed',
  'mail_shed',
  'network_limited',
] as const;

/**
 * Fetches the already-evaluated conditions from `/api/ops/alerts`. Never
 * throws: a non-2xx response, a body without a `conditions` array, or a
 * fetch failure (a deploy fault or the app being down) comes back as
 * `{ ok: false, error }` so `main` can still post to Incidents instead of
 * dying before it posts anything. A Redis outage is not one of these: the
 * endpoint still answers, from what the app saw itself, and says it could
 * not read its alert state (ISSUE-191); `alertStateRead` carries that, and
 * anything but an explicit "read" counts as unread (ISSUE-199).
 */
export async function fetchAlertConditions(
  origin: string,
  token: string,
  timeoutMs: number = PROBE_FETCH_TIMEOUT_MS,
): Promise<AlertConditionsResult> {
  try {
    const response = await fetch(new URL('/api/ops/alerts', origin), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return {
        ok: false,
        error: `/api/ops/alerts responded ${response.status}`,
      };
    const body = parseAlertsBody(await response.json());
    if (!body.ok)
      return {
        ok: false,
        error: `/api/ops/alerts answered an unreadable alert state: ${body.problem}`,
      };
    return {
      ok: true,
      conditions: body.conditions,
      alertStateRead: body.alertStateRead,
    };
  } catch (error) {
    return {
      ok: false,
      error: `/api/ops/alerts request failed: ${(error as Error).message}`,
    };
  }
}

export type ProbeOutcome =
  | { readonly healthy: true; readonly message: null }
  | { readonly healthy: false; readonly message: string };

/**
 * Pure: decides whether the probe run is healthy and, if not, the message
 * to post. An unreachable `/api/ops/alerts` (a deploy fault or any other
 * failure) is itself treated as an alert-worthy condition, not a reason to
 * skip posting, so a failing endpoint still reaches Incidents
 * (AUTH-7.7-AC2/ISSUE-156). So is an alert state the endpoint could not
 * read, whatever readiness says (ISSUE-199).
 */
export function decideProbeOutcome(input: {
  readonly originProbe: OriginProbeResult;
  readonly alertConditions: AlertConditionsResult;
  readonly runUrl?: string;
}): ProbeOutcome {
  if (!input.alertConditions.ok)
    return {
      healthy: false,
      message: composeAlertMessage({
        conditions: [],
        originIssues: [
          ...input.originProbe.issues,
          `alert conditions unavailable: ${input.alertConditions.error}`,
        ],
        runUrl: input.runUrl,
      }),
    };
  const { conditions, alertStateRead } = input.alertConditions;
  if (conditions.length === 0 && input.originProbe.ok && alertStateRead)
    return { healthy: true, message: null };
  return {
    healthy: false,
    message: composeAlertMessage({
      conditions,
      originIssues: [
        ...input.originProbe.issues,
        ...(alertStateRead
          ? []
          : [
              `alert state unread: /api/ops/alerts could not read its Redis alert state, so ${UNEVALUATED_WITHOUT_ALERT_STATE.join(', ')} were not evaluated`,
            ]),
      ],
      runUrl: input.runUrl,
    }),
  };
}

const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * Pure: the bearer token comes only from the environment — this takes no
 * `args` parameter at all, so a `--token` on the command line (the shape
 * AUTH-7.11 removed everywhere else) has no way to reach it, even if one
 * were still passed.
 */
export const resolveProbeToken = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => env.OPS_PROBE_TOKEN;

export type ProbeConfig = {
  readonly origin: string;
  readonly token: string;
  readonly runUrl: string | undefined;
};

/**
 * Pure: the full set of inputs `main` needs, or `undefined` when required
 * inputs are missing — refusal, not just token resolution, is what a
 * regression reintroducing a `--token` fallback must be caught changing.
 * `args` here can carry any flag, including a stray `--token`; only
 * `resolveProbeToken`'s environment lookup can ever supply the token.
 */
export function resolveProbeConfig(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ProbeConfig | undefined {
  const origin = flag(args, 'origin');
  const token = resolveProbeToken(env);
  const runUrl = flag(args, 'run-url');
  return origin && token ? { origin, token, runUrl } : undefined;
}

export type ProbeDependencies = {
  readonly fetchOriginProbe: (origin: string) => Promise<OriginProbeResult>;
  readonly fetchAlertConditions: (
    origin: string,
    token: string,
  ) => Promise<AlertConditionsResult>;
  readonly decide: typeof decideProbeOutcome;
  /** Posts to Incidents; true once delivered. */
  readonly notify: (message: string) => boolean;
  readonly log: (line: string) => void;
};

/**
 * The fail-closed message for a probe that threw before it could decide.
 * Plain string building only: whatever threw may have been
 * `composeAlertMessage` itself.
 */
const probeFailureMessage = (error: unknown, runUrl?: string) =>
  [
    '🔴 AUTH-7.7 alert probe',
    `- origin_probe: unreadable alert state: the probe failed before it could decide (${error instanceof Error ? error.message : String(error)}), so every condition is unknown`,
    ...(runUrl ? [runUrl] : []),
  ].join('\n');

/**
 * One probe run: probe, decide, and post whatever is wrong. It never ends
 * without posting when something is wrong: anything that throws posts
 * `probeFailureMessage` and exits 1 (ISSUE-209). The exit code is 0 once
 * the run is healthy or its alert was delivered, 1 otherwise.
 */
export async function runProbe(
  config: ProbeConfig,
  dependencies: ProbeDependencies,
): Promise<number> {
  try {
    const originProbe = await dependencies.fetchOriginProbe(config.origin);
    const alertConditions = await dependencies.fetchAlertConditions(
      config.origin,
      config.token,
    );
    const outcome = dependencies.decide({
      originProbe,
      alertConditions,
      runUrl: config.runUrl,
    });
    if (outcome.healthy) {
      dependencies.log('AUTH-7.7 probe: healthy, nothing to report');
      return 0;
    }
    dependencies.log(outcome.message);
    return dependencies.notify(outcome.message) ? 0 : 1;
  } catch (error) {
    const message = probeFailureMessage(error, config.runUrl);
    dependencies.log(message);
    dependencies.notify(message);
    return 1;
  }
}

/**
 * Posts through `notify-drive.ts`, which bounds each delivery attempt. Like
 * the probe itself in `auth-alerts.yml`, it never auto-installs, and it
 * imports no package either (ISSUE-225).
 */
const notifyIncidents = (message: string): boolean =>
  Bun.spawnSync(
    [
      'bun',
      '--no-install',
      'scripts/notify-drive.ts',
      'incidents',
      '--message',
      message,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  ).exitCode === 0;

async function main(): Promise<void> {
  const config = resolveProbeConfig(process.argv.slice(2), process.env);
  if (!config) {
    process.stderr.write(
      'usage: OPS_PROBE_TOKEN=<token> bun --no-install scripts/auth-alert-probe.ts --origin <https url> [--run-url <url>]\n',
    );
    process.exit(2);
    return;
  }
  process.exit(
    await runProbe(config, {
      fetchOriginProbe,
      fetchAlertConditions,
      decide: decideProbeOutcome,
      notify: notifyIncidents,
      log: (line) => console.log(line),
    }),
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHttpClient } from './http-client';
import { localServices } from './local-services';
import { percentile, successRate, tally, unexpected5xxRate } from './metrics';
import { provisionPopulation } from './provision';
import { simulatedClients } from './client-identity';
import { startTwoInstances } from './two-instances';
import {
  runWorkloadRequest,
  workloadKindFor,
  type WorkloadOutcome,
} from './workload';

/**
 * AUTH-6.7 AC2/AC4: the timed baseline load run. Two application instances
 * behind one shared origin (`two-instances.ts`, or `--base-url` against an
 * already-deployed pair for a staging run — see the README's owner-approval
 * gate before ever pointing this at staging), 50 simulated clients rotating
 * the shipped 80/10/10 workload evenly, admitted at a fixed target rate for
 * the run's whole duration. Writes a JSON and Markdown report under
 * `reports/`.
 */

type Args = {
  readonly durationSeconds: number;
  readonly clientCount: number;
  readonly targetRps: number;
  readonly sessionAccountCount: number;
  readonly passkeyAccountCount: number;
  readonly requestTimeoutMs: number;
  readonly label: string;
  readonly baseUrl?: string;
};

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string, fallback: string) =>
    argv
      .find((entry) => entry.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ?? fallback;
  const positive = (name: string, fallback: string) => {
    const value = Number(flag(name, fallback));
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`--${name} must be a finite number greater than 0`);
    return value;
  };
  const positiveInteger = (name: string, fallback: string) => {
    const value = positive(name, fallback);
    if (!Number.isInteger(value))
      throw new Error(`--${name} must be a positive integer`);
    return value;
  };
  const baseUrl = argv.find((entry) => entry.startsWith('--base-url='));
  return {
    durationSeconds: positive('duration-seconds', '600'),
    clientCount: positiveInteger('clients', '50'),
    targetRps: positive('target-rps', '20'),
    sessionAccountCount: positiveInteger('session-accounts', '50'),
    passkeyAccountCount: positiveInteger('passkey-accounts', '10'),
    requestTimeoutMs: positive('request-timeout-ms', '5000'),
    label: flag('label', 'local'),
    ...(baseUrl ? { baseUrl: flag('base-url', '') } : {}),
  };
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const startedAt = new Date();

  const instances = args.baseUrl
    ? undefined
    : await startTwoInstances(localServices());
  const originUrl = args.baseUrl ?? instances!.originUrl;
  const mailPorts = instances?.mailPorts;
  if (mailPorts)
    // A clean limiter state: this checkout's e2e Redis namespace may still
    // carry counters from an earlier local run in the same window.
    await Promise.all(
      mailPorts.map((port) =>
        fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' }),
      ),
    );

  console.log(`[auth-load] target origin: ${originUrl}`);
  console.log(
    `[auth-load] provisioning ${args.sessionAccountCount} session accounts and ${args.passkeyAccountCount} passkey accounts`,
  );
  if (!mailPorts)
    throw new Error(
      'A --base-url run needs a reachable private mail sink for provisioning; only the local two-instance mode is wired for that today.',
    );
  const population = await provisionPopulation({
    originUrl,
    mailPorts,
    sessionAccountCount: args.sessionAccountCount,
    passkeyAccountCount: args.passkeyAccountCount,
  });
  console.log('[auth-load] provisioning complete; starting timed run');

  const http = createHttpClient(originUrl);
  const clients = simulatedClients(args.clientCount);
  const outcomes: WorkloadOutcome[] = [];
  // Each simulated client rotates the 80/10/10 mix across its OWN request
  // sequence ("50 independently authenticated clients, rotating requests
  // evenly"), never a shared global counter: the shipped per-client
  // magic-link rule (3/60s) is scoped to one client's identity, so
  // dispatch order among clients must never let one client draw more than
  // its fair share of the magic-link slot.
  const clientRequestIndex = new Array<number>(args.clientCount).fill(0);
  let inFlight = 0;
  let maxInFlight = 0;
  const cycleMs = (1000 * args.clientCount) / args.targetRps;
  const started = performance.now();
  const runUntil = started + args.durationSeconds * 1000;
  const pending: Array<Promise<void>> = [];

  const fireOne = async (clientIndex: number) => {
    const cursor = clientRequestIndex[clientIndex]!;
    clientRequestIndex[clientIndex] = cursor + 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const outcome = await runWorkloadRequest({
        http,
        originUrl,
        kind: workloadKindFor(cursor),
        clientHeader: { 'x-forwarded-for': clients[clientIndex]! },
        sessionAccounts: population.sessionAccounts,
        passkeyAccounts: population.passkeyAccounts,
        cursor,
        timeoutMs: args.requestTimeoutMs,
      });
      outcomes.push(outcome);
    } finally {
      inFlight -= 1;
    }
  };

  for (let cycle = 0; performance.now() < runUntil; cycle += 1) {
    for (
      let clientIndex = 0;
      clientIndex < args.clientCount;
      clientIndex += 1
    ) {
      const dueAt =
        started + cycle * cycleMs + clientIndex * (cycleMs / args.clientCount);
      const waitMs = dueAt - performance.now();
      if (waitMs > 0) await Bun.sleep(waitMs);
      if (performance.now() >= runUntil) break;
      pending.push(fireOne(clientIndex));
    }
  }
  await Promise.all(pending);
  const elapsedSeconds = (performance.now() - started) / 1000;

  const tallies = tally(outcomes);
  const latenciesMs = outcomes.map((outcome) => outcome.latencyMs);
  // The success-rate threshold is over admitted traffic, never over the
  // shipped limiter's own deliberate 429s (AUTH-6.7 AC4: "report deliberate
  // 429s ... separately"). Only the magic-link segment's 429s are excluded:
  // it sits right at the shipped global ceiling by construction (see
  // README), so counting its expected 429s against the 99% bar would fail
  // the run for exercising the workload exactly as specified, not for a
  // real capacity problem. A 429 storm on session-read or passkey-assertion
  // stays in the admitted count and fails the bar (successRate, ISSUE-165).
  const { admitted, rate: successRateValue } = successRate(tallies);
  const report = {
    label: args.label,
    startedAt: startedAt.toISOString(),
    elapsedSeconds,
    originUrl,
    workload: {
      clientCount: args.clientCount,
      targetRps: args.targetRps,
      durationSeconds: args.durationSeconds,
      mix: '80% session-read / 10% magic-link / 10% passkey-assertion',
    },
    population: {
      sessionAccounts: population.sessionAccounts.length,
      passkeyAccounts: population.passkeyAccounts.length,
    },
    maxInFlight,
    p50Ms: percentile(latenciesMs, 50),
    p95Ms: percentile(latenciesMs, 95),
    p99Ms: percentile(latenciesMs, 99),
    unexpected5xxRate: unexpected5xxRate(tallies.overall),
    successRate: successRateValue,
    admitted,
    tallies,
    thresholds: {
      p95BelowMs: 500,
      unexpected5xxBelow: 0.01,
      successRateAtLeast: 0.99,
    },
    passed: {
      p95: percentile(latenciesMs, 95) < 500,
      unexpected5xx: unexpected5xxRate(tallies.overall) < 0.01,
      successRate: admitted > 0 && successRateValue >= 0.99,
    },
  };

  await instances?.stop();

  const dir = `${import.meta.dir}/reports/${startedAt.toISOString().replace(/[:.]/g, '-')}-${args.label}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${dir}/report.md`, renderMarkdown(report));
  console.log(`[auth-load] wrote ${dir}/report.json and report.md`);
  console.log(JSON.stringify(report.passed));
}

function renderMarkdown(report: Record<string, unknown>): string {
  const r = report as {
    label: string;
    startedAt: string;
    elapsedSeconds: number;
    originUrl: string;
    workload: Record<string, unknown>;
    population: Record<string, unknown>;
    maxInFlight: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    unexpected5xxRate: number;
    successRate: number;
    admitted: number;
    tallies: Record<string, unknown>;
    passed: { p95: boolean; unexpected5xx: boolean; successRate: boolean };
  };
  return [
    `# AUTH-6.7 load report — ${r.label}`,
    '',
    `Started: ${r.startedAt}. Elapsed: ${r.elapsedSeconds.toFixed(1)}s. Origin: ${r.originUrl}.`,
    '',
    '## Workload',
    '```json',
    JSON.stringify(r.workload, null, 2),
    '```',
    '',
    '## Population',
    '```json',
    JSON.stringify(r.population, null, 2),
    '```',
    '',
    '## Results',
    `- Max concurrent in-flight requests: ${r.maxInFlight}`,
    `- p50 / p95 / p99 server latency: ${r.p50Ms.toFixed(1)}ms / ${r.p95Ms.toFixed(1)}ms / ${r.p99Ms.toFixed(1)}ms`,
    `- Unexpected 5xx rate: ${(r.unexpected5xxRate * 100).toFixed(3)}%`,
    `- Success rate: ${(r.successRate * 100).toFixed(3)}%`,
    `- Admitted (offered minus the magic-link segment's deliberate 429s): ${r.admitted}`,
    '',
    '## Thresholds',
    `- p95 < 500ms: ${r.passed.p95 ? 'PASS' : 'FAIL'}`,
    `- Unexpected 5xx < 1%: ${r.passed.unexpected5xx ? 'PASS' : 'FAIL'}`,
    `- Success rate >= 99%: ${r.passed.successRate ? 'PASS' : 'FAIL'}`,
    '',
    '## Outcome tallies (offered/successful/rejectedByStatus/timedOut/unexpectedFailure)',
    '```json',
    JSON.stringify(r.tallies, null, 2),
    '```',
    '',
  ].join('\n');
}

await main();

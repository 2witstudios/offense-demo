import { mkdirSync, writeFileSync } from 'node:fs';
import { createHttpClient } from './http-client';
import { localServices } from './local-services';
import { simulatedClients } from './client-identity';
import { startTwoInstances } from './two-instances';

/**
 * AUTH-6.7 AC4's companion run: "Run abusive/rate-limit load separately and
 * assert the expected 429s." The baseline run in `run.ts` never approaches
 * a shipped ceiling; this run deliberately does, against the real
 * two-instance topology, and fails loudly if the shipped limiter admits
 * more than the documented ceiling or fails to answer `Retry-After`.
 */
async function main() {
  const args = {
    label: Bun.argv[2]?.startsWith('--label=') ? Bun.argv[2].slice(8) : 'local',
  };
  const instances = await startTwoInstances(localServices());
  // A clean limiter state: this checkout's e2e Redis namespace may still
  // carry counters from an earlier local run in the same window.
  await Promise.all(
    instances.mailPorts.map((port) =>
      fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' }),
    ),
  );
  const http = createHttpClient(instances.originUrl);
  const client = simulatedClients(1)[0]!;
  const header = { 'x-forwarded-for': client };

  // 30 simultaneous magic-link requests from one client, split across both
  // instances by the shared TLS edge's round robin: the shipped rule is
  // 3/60s per client, atomic across instances (already proven in
  // auth-rate-limit.integration.ts and auth-cross-instance.integration.ts;
  // this run additionally proves it holds under real concurrent HTTP load).
  const responses = await Promise.all(
    Array.from({ length: 30 }, (_, index) =>
      http.jsonPost(
        '/api/auth/sign-in/magic-link',
        { email: `auth-load-abuse-${index}-${Date.now()}@example.test` },
        header,
      ),
    ),
  );
  const admitted = responses.filter(
    (response) => response.status === 200,
  ).length;
  const denied = responses.filter((response) => response.status === 429);
  const retryAfterPresent = denied.every(
    (response) => Number(response.headers.get('retry-after')) >= 1,
  );

  await instances.stop();

  const pass = admitted === 3 && denied.length === 27 && retryAfterPresent;
  const report = {
    label: args.label,
    startedAt: new Date().toISOString(),
    scenario: '30 simultaneous magic-link requests from one simulated client',
    expectedAdmitted: 3,
    admitted,
    denied: denied.length,
    retryAfterPresentOnEveryDenial: retryAfterPresent,
    passed: pass,
  };
  const dir = `${import.meta.dir}/reports/${report.startedAt.replace(/[:.]/g, '-')}-abuse-${args.label}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(`[auth-load-abuse] wrote ${dir}/report.json`);
  console.log(JSON.stringify(report));
  if (!pass) process.exit(1);
}

await main();

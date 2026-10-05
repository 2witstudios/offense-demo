import { freePort } from './free-port';
import { createSelfSignedTlsEdge } from '../../e2e/support/tls-edge';

export type LoadServices = {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly redisNamespace: string;
};

export type RunningInstances = {
  readonly originUrl: string;
  readonly mailPorts: readonly [number, number];
  readonly stop: () => Promise<void>;
};

const webDir = new URL('../..', import.meta.url).pathname;

/**
 * The options `startTwoInstances` spawns each instance process with.
 * Exported so a test can assert `stdin: 'pipe'` (ISSUE-150/151) without
 * spawning a real process: that pipe, never written to or closed here, is
 * the OS-delivered EOF the instance's `watchParentLiveness` relies on when
 * this driver process dies for any reason, including a SIGKILL that never
 * reaches the child with SIGTERM.
 */
export function instanceSpawnOptions(
  port: number,
  mailPort: number,
  sharedEnv: Readonly<Record<string, string | undefined>>,
): Bun.SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'> {
  return {
    cwd: webDir,
    env: {
      ...sharedEnv,
      PORT: String(port),
      LOAD_MAIL_PORT: String(mailPort),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  };
}

/** Polls `url` (ignoring the self-signed edge certificate) until it answers OK. */
async function waitForReady(url: string, attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { tls: { rejectUnauthorized: false } });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`${url} did not become ready in time`);
}

/**
 * AUTH-6.7: two production application instances over one shared
 * `DATABASE_URL` and `REDIS_NAMESPACE`, behind one shared TLS edge that
 * round-robins across them — one public origin, no sticky session, exactly
 * the topology the leaf's criteria run against. Each instance keeps its own
 * private mail sink (`mailPorts`); a caller checking magic-link delivery
 * during the run must check both, since a request can land on either.
 */
export async function startTwoInstances(
  services: LoadServices,
): Promise<RunningInstances> {
  const ports = {
    appA: freePort(),
    appB: freePort(),
    edge: freePort(),
    mailA: freePort(),
    mailB: freePort(),
  };
  const originUrl = `https://localhost:${ports.edge}`;
  const sharedEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PUBLIC_APP_URL: originUrl,
    APP_VERSION: 'auth-load',
    GIT_COMMIT: 'local-auth-load',
    DATABASE_URL: services.databaseUrl,
    REDIS_URL: services.redisUrl,
    REDIS_NAMESPACE: services.redisNamespace,
    LOG_LEVEL: 'warn',
    // The harness's own loopback fetch to the shared TLS edge is the only
    // hop each instance sees; trusting it is what lets a caller-supplied
    // X-Forwarded-For assign each simulated client its own rate-limit
    // identity (AUTH-6.7 AC2/AC4: "the test ingress's trusted connection
    // setup, not spoofable public headers" — the header is trusted only
    // because it arrives through this explicitly configured loopback hop).
    AUTH_TRUSTED_PROXIES: '127.0.0.1',
    // Inert: outbound mail never reaches Resend (mail-capture.ts intercepts
    // it), and no webhook is ever delivered.
    BETTER_AUTH_SECRET:
      '3f7ccdc8a1c17f0c3c8fd72be8c1e74d7d3d66dfd44ed9f8aca2b9ecd6e01733',
    RECIPIENT_HASH_SECRET:
      '4a8ddce9b2d28f1d4d9fe83cf9d2f85e8e4e77e0e55fea09bdb3caeed7f12844',
    RESEND_API_KEY: 're_auth_load_placeholder_not_a_credential',
    AUTH_EMAIL_FROM: 'Offense Demo <no-reply@auth-load.offense-demo.invalid>',
    RESEND_WEBHOOK_SECRET:
      'whsec_YXV0aC1sb2FkLXBsYWNlaG9sZGVyLW5vdC1hLXNlY3JldA==',
    // AUTH-7.7: gates /api/ops/alerts and /api/ops/metrics; this harness
    // never calls them.
    OPS_PROBE_TOKEN: 'auth-load-ops-probe-token-placeholder-not-a-credential',
  };
  const spawnInstance = (port: number, mailPort: number) =>
    Bun.spawn(
      ['bun', 'run', 'scripts/auth-load/instance-process.ts'],
      instanceSpawnOptions(port, mailPort, sharedEnv),
    );
  const instanceA = spawnInstance(ports.appA, ports.mailA);
  const instanceB = spawnInstance(ports.appB, ports.mailB);
  const edge = createSelfSignedTlsEdge({
    appPort: [ports.appA, ports.appB],
    edgePort: ports.edge,
  });

  try {
    // Each instance directly, on its own plain-HTTP app port: probing both
    // through the round-robin edge can route both checks to the same
    // instance by chance, resolving while the other is still unready.
    await Promise.all([
      waitForReady(`http://127.0.0.1:${ports.appA}/api/health/ready`, 60),
      waitForReady(`http://127.0.0.1:${ports.appB}/api/health/ready`, 60),
    ]);
  } catch (error) {
    instanceA.kill();
    instanceB.kill();
    edge.stop(true);
    throw error;
  }

  const stop = async () => {
    edge.stop(true);
    instanceA.kill('SIGTERM');
    instanceB.kill('SIGTERM');
    await Promise.all([instanceA.exited, instanceB.exited]);
  };

  return { originUrl, mailPorts: [ports.mailA, ports.mailB], stop };
}

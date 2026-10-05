import { systemClock, systemId } from '@offense-demo/clock';
import {
  installForcedShutdown,
  watchParentLiveness,
  type LivenessStdin,
  type SignalTarget,
} from '@offense-demo/observability';
import { createApp } from '../../src/server/app';
import { adoptProcessApp } from '../../src/server/process-app';
import { createMailCapture } from '../../e2e/support/mail-capture';

/**
 * AUTH-6.7: one production application instance for the load harness's
 * two-instance topology. Plain HTTP on `PORT`, its own private mail sink
 * on `LOAD_MAIL_PORT` for the workload's magic-link segment; `PUBLIC_APP_URL`
 * and every other config value are shared with its sibling instance
 * (`two-instances.ts`), which fronts both with one shared TLS edge — one
 * public origin round-robining across two backend processes over one
 * `DATABASE_URL` and `REDIS_NAMESPACE`, never a single process and never
 * a sticky session. Spawned by `two-instances.ts`, never run directly.
 */

/**
 * ISSUE-150/151: this instance's forced-exit and parent-liveness seams.
 * Exported so a test can call the real function this file wires (not a
 * copy of its logic) against injected fakes, and so a reversion of the
 * call below, or of its drain budget, fails that test. Every dependency
 * defaults to the real one `import.meta.main` below uses.
 */
export function wireInstanceLifecycle({
  drainBudgetMs = 3000,
  exit = (code: number) => process.exit(code),
  stdin = process.stdin,
  target = process,
  forceShutdown = installForcedShutdown,
  watchLiveness = watchParentLiveness,
}: {
  readonly drainBudgetMs?: number;
  readonly exit?: (code: number) => void;
  readonly stdin?: LivenessStdin;
  readonly target?: SignalTarget;
  readonly forceShutdown?: typeof installForcedShutdown;
  readonly watchLiveness?: typeof watchParentLiveness;
} = {}): void {
  forceShutdown({ drainBudgetMs, exit, target });
  watchLiveness({ stdin, onParentGone: () => exit(0) });
}

if (import.meta.main) {
  // Installed before the potentially slow `import('../../src/server/
  // start')` below, so a hang during start-up can never leave this
  // instance ignoring SIGTERM/SIGINT, and so a stdin pipe closing (the
  // parent driver dying without calling `two-instances.ts`'s `stop()`) is
  // caught from the first tick this process runs.
  wireInstanceLifecycle();

  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };

  const mailPort = Number(env('LOAD_MAIL_PORT'));

  const mailCapture = createMailCapture({
    port: mailPort,
    redisUrl: env('REDIS_URL'),
    redisNamespace: env('REDIS_NAMESPACE'),
  });

  adoptProcessApp(
    createApp({
      env: process.env,
      fetch: mailCapture.captureFetch,
      clock: systemClock,
      ids: systemId,
    }),
  );

  await import('../../src/server/start');
}

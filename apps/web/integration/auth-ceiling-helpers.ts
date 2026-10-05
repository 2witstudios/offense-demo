import { createAccountFlows } from './auth-account-helpers';
import { elapse, holdOpenIfSaturated } from './auth-rate-limit-helpers';
import type { TestApp } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';

/** The global per-minute sign-up ceiling's bucket. */
export const GLOBAL_MINUTE = 'auth:magic-link:global:60';

/** The global per-minute sign-up ceiling (`MAGIC_LINK_GLOBAL_RULES`). */
const GLOBAL_MINUTE_MAX = 120;

/**
 * Saturates the global minute ceiling with real requests and holds it open
 * for the whole test. Each attempt starts a fresh window and sends one
 * request past the ceiling; the window is held only once its real counter
 * is seen past the ceiling, so a window that expired while the machine was
 * slow is filled again instead of pinned half empty (ISSUE-281).
 */
export async function saturateGlobalMinute(
  flows: {
    readonly testApp: TestApp;
    readonly magicLink: (email: string) => Promise<Response>;
    readonly fresh: () => string;
    readonly settled: () => Promise<void>;
  },
  holdMs = 600_000,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await elapse(flows.testApp, GLOBAL_MINUTE);
    await Promise.all(
      Array.from({ length: GLOBAL_MINUTE_MAX + 1 }, () =>
        flows.magicLink(flows.fresh()),
      ),
    );
    await flows.settled();
    if (
      await holdOpenIfSaturated(
        flows.testApp,
        GLOBAL_MINUTE,
        GLOBAL_MINUTE_MAX,
        holdMs,
      )
    )
      return;
  }
  throw new Error('The global minute ceiling never stayed saturated');
}

/**
 * The global sign-up ceiling suites' harness: real accounts, a magic-link
 * request from its own client (or a given one), the minute window elapsing,
 * and the work a saturated request finishes after its answer.
 */
export function createCeilingFlows(app?: TestApp) {
  const accounts = createAccountFlows(app);
  const { flows } = accounts;
  const { testApp, newClient } = flows;
  const magicLink = (email: string, client = newClient()) =>
    flows.authRoute.POST(
      flows.jsonPost(
        '/api/auth/sign-in/magic-link',
        { email },
        { [CLIENT_IP_HEADER]: client },
      ),
    );
  return {
    accounts,
    ...flows,
    magicLink,
    /** The global minute window elapsing: its real counter key expires. */
    elapseGlobalMinute: () => elapse(testApp, GLOBAL_MINUTE),
    /** Post-answer work (a saturated ceiling's sends and drops) finished. */
    settled: () => testApp.app.auth().settled(),
  };
}

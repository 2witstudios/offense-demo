import { closeCodeTable, type CloseCodeReason } from '@offense-demo/protocol';
import type { ReconnectKind } from './backoff';

/**
 * The per-close-code client reaction (ADR 0031 §8): a pure decision from a
 * close code and how many *consecutive* auth-failed closes preceded it
 * (reset to 0 on every successful `ready`, by the caller).
 * `AUTH_FAILURE_LIMIT` matches the table's "after 3 consecutive failures,
 * stop and show signed-out state": this decision is for the 3rd failure
 * itself, so it fires once `consecutiveAuthFailures` (the count *before*
 * this one) reaches 2.
 */
const AUTH_FAILURE_LIMIT = 3;

export type TerminalReason = 'revoked' | 'unsupported' | 'signed-out';

export type CloseDecision =
  | {
      readonly reconnect: true;
      readonly refreshTicket: boolean;
      readonly backoffKind: ReconnectKind;
      readonly terminal: null;
    }
  | {
      readonly reconnect: false;
      readonly refreshTicket: false;
      readonly backoffKind: null;
      readonly terminal: TerminalReason;
    };

function reconnect(
  backoffKind: ReconnectKind,
  refreshTicket: boolean,
): CloseDecision {
  return { reconnect: true, refreshTicket, backoffKind, terminal: null };
}
function stop(terminal: TerminalReason): CloseDecision {
  return {
    reconnect: false,
    refreshTicket: false,
    backoffKind: null,
    terminal,
  };
}

/**
 * Resolves a close code to `@offense-demo/protocol`'s own reason name, the single
 * authority `apps/realtime` already codes against (`hello.ts`'s
 * `closeFor`). A code the table does not list (1000, 1001, 1006, or an
 * unrecognized application code) resolves to `null`, so this client never
 * hard-codes the table's numbers itself.
 */
export function closeReasonForCode(code: number): CloseCodeReason | null {
  return closeCodeTable.find((row) => row.code === code)?.reason ?? null;
}

export function decideOnClose({
  code,
  consecutiveAuthFailures,
}: {
  readonly code: number;
  readonly consecutiveAuthFailures: number;
}): CloseDecision {
  switch (closeReasonForCode(code)) {
    case 'auth_failed':
      return consecutiveAuthFailures + 1 >= AUTH_FAILURE_LIMIT
        ? stop('signed-out')
        : reconnect('standard', true);
    case 'revoked':
      return stop('revoked');
    case 'protocol_unsupported':
      return stop('unsupported');
    case 'rate_limited':
      return reconnect('rate-limited', false);
    case 'slow_consumer':
      return reconnect('standard', false);
    case 'server_restarting':
      return reconnect('immediate', false);
    default:
      // 1000, 1001, 1006 and any code the table does not list are all
      // treated as 1006 (ADR 0031 §8: "an unknown code is treated as 1006").
      return reconnect('standard', false);
  }
}

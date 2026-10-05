import {
  clientMessageSchema,
  closeCodeTable,
  type CloseCodeReason,
} from '@offense-demo/protocol';

export type FirstMessageOutcome = {
  readonly code: number;
  readonly reason: CloseCodeReason;
};

/** The protocol's close code for a reason: the table is the one authority. */
export const closeFor = (reason: CloseCodeReason): FirstMessageOutcome => {
  const entry = closeCodeTable.find((row) => row.reason === reason);
  if (!entry) throw new Error(`No close code for ${reason}`);
  return { code: entry.code, reason: entry.reason };
};
const AUTH_FAILED = closeFor('auth_failed');
const PROTOCOL_UNSUPPORTED = closeFor('protocol_unsupported');

/**
 * ADR 0031 §6, §11: evaluates a socket's first inbound frame. An unparseable
 * frame, or any message before `hello`, closes the socket; `hello` itself
 * authenticates by consuming a ticket (RT-2.4b), which does not exist yet,
 * so every `hello` here is rejected the same way a bad one would be. That
 * keeps the wire contract already correct (parse, then close) rather than
 * standing up a stub "success" path RT-2.4b would have to tear out.
 */
export function evaluateFirstMessage(raw: string): FirstMessageOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return PROTOCOL_UNSUPPORTED;
  }
  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) return PROTOCOL_UNSUPPORTED;
  // A valid non-hello message before hello, and a valid hello (ticket
  // consumption is not implemented yet), are both auth_failed.
  return AUTH_FAILED;
}

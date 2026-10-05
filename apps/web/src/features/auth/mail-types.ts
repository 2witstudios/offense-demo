/**
 * The auth mail contract, owned here rather than in server.ts: mail.ts,
 * magic-link-gate.ts, email-change.ts and deliver-or-unavailable.ts
 * all need these types, and importing them back from server.ts (which
 * imports those same modules for their values) formed a nominal import
 * cycle. Type-only imports are erased at runtime, so it was never a real
 * cycle, but this is the one place these types are defined.
 */
export type AuthEmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};
/** Provider receipt; correlates later delivery events, holds no recipient data. */
type AuthEmailReceipt = { readonly providerMessageId: string };
export type AuthEmailSender = {
  readonly send: (
    message: AuthEmailMessage,
  ) => Promise<AuthEmailReceipt | void>;
};
/** Durable mail diagnostics + suppression owned by @offense-demo/db. */
export type AuthDeliveryLedger = {
  readonly isSuppressed: (recipientHash: string) => Promise<boolean>;
  readonly record: (input: {
    readonly providerMessageId: string;
    readonly recipientHash: string;
    readonly at: string;
  }) => Promise<void>;
};

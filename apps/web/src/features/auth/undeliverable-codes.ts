/**
 * The 422 codes an undeliverable address answers (ADR 0025). They are
 * defined once, here, so the server that throws them and the forms that
 * explain them share one spelling. The module imports nothing, so
 * browser code can read it.
 */

/** The address asked about hard-bounced or complained: use another one. */
export const EMAIL_UNDELIVERABLE = 'EMAIL_UNDELIVERABLE';

/**
 * The address on file cannot receive the email-change approval, so the
 * change cannot be approved by email. Picking another new address would
 * not help (ISSUE-113).
 */
export const CURRENT_EMAIL_UNDELIVERABLE = 'CURRENT_EMAIL_UNDELIVERABLE';

export type UndeliverableCode =
  typeof EMAIL_UNDELIVERABLE | typeof CURRENT_EMAIL_UNDELIVERABLE;

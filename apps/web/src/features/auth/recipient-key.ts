import { createHash } from 'node:crypto';

/** The one place an email address is trimmed and lowercased before use. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

/**
 * A subkey derived once from a secret, domain-separated by a fixed label per
 * use, so a leaked subkey can never double as a leaked secret or as another
 * use's subkey.
 */
export const deriveSubkey = (secret: string, label: string): string =>
  createHash('sha3-256').update(`${secret}\0${label}`).digest('hex');

/**
 * Keyed by `RECIPIENT_HASH_SECRET`, never `BETTER_AUTH_SECRET` (ADR 0044,
 * ISSUE-141): the session-signing secret is expected to rotate, and a
 * rotation must never desynchronize the suppression ledger or the
 * per-recipient rate-limit buckets from the hashes already stored under
 * them.
 */
export const deriveRecipientSubkey = (secret: string): string =>
  deriveSubkey(secret, 'recipient-key');

/**
 * The one recipient identity used everywhere a recipient must be compared,
 * stored or bucketed without ever holding the address itself: the delivery
 * ledger's suppression lookups and receipts, the magic-link gate's
 * suppression check, and the rate-limit gate's per-recipient buckets.
 * Keyed by the derived subkey, never a raw secret directly.
 */
export const recipientKey = (subkey: string, email: string): string =>
  createHash('sha3-256')
    .update(`${subkey}\0${normalizeEmail(email)}`)
    .digest('hex');

import { createHash } from 'node:crypto';

/**
 * The zero-trust model every emailed link follows (ISSUE-2, ADR 0025): the
 * link carries only an opaque CSPRNG token; the server stores its SHA3-256
 * digest keyed by purpose, with the subject in the row's value and its
 * expiry, and consumes it atomically once. Nothing about the account or the
 * operation travels inside the token.
 */
export const EMAILED_LINK_PURPOSES = [
  'sign-in',
  'email-change-approve',
  'email-change-verify',
] as const;

export type EmailedLinkPurpose = (typeof EMAILED_LINK_PURPOSES)[number];

/** 32 CSPRNG bytes (256 bits), base64url-encoded: 43 characters. */
export function generateEmailedLinkToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    'base64url',
  );
}

/**
 * The only form of a token the server keeps. The purpose prefix scopes the
 * lookup, so a token issued for one flow can never be consumed by another.
 */
export const emailedLinkIdentifier = (
  purpose: EmailedLinkPurpose,
  token: string,
): string => `${purpose}:${createHash('sha3-256').update(token).digest('hex')}`;

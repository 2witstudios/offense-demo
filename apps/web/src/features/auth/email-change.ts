import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  sensitiveSessionMiddleware,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';
import type { Clock } from '@offense-demo/clock';
import {
  sendOrUnavailable,
  type Deliver,
  type UndeliverableRefusal,
} from './deliver-or-unavailable';
import {
  emailedLinkIdentifier,
  generateEmailedLinkToken,
  type EmailedLinkPurpose,
} from './emailed-link-token';
import { renderAuthEmail } from './mail/templates';
import type {
  SuppressionCheck,
  SuppressionRefusals,
} from './suppression-check';
import {
  CURRENT_EMAIL_UNDELIVERABLE,
  EMAIL_UNDELIVERABLE,
} from './undeliverable-codes';

/** Same five-minute figure as a sign-in link (ADR 0025). */
export const EMAIL_CHANGE_LINK_EXPIRES_IN_SECONDS = 300;

/** The confirm page every email-change link opens (`confirm-email.ts`). */
export const CONFIRM_EMAIL_PATH = '/auth/confirm-email';

/** Where the notice to a taken new address points its owner (ISSUE-119). */
const SECURITY_SETTINGS_PATH = '/settings/security';

/** The one redemption path; only the confirm page's internal forward reaches it. */
export const EMAIL_CHANGE_VERIFY_PATH = '/email-change/verify';

/**
 * ISSUE-99: the final step's one transaction (`@offense-demo/db`'s
 * `completeEmailChange`): move the account to the new address and delete
 * every outstanding sign-in link (stored under `signInPurpose`) whose
 * subject is the old one. `stale` changed nothing.
 */
export type CompleteEmailChange = (input: {
  readonly userId: string;
  readonly email: string;
  readonly newEmail: string;
  readonly signInPurpose: EmailedLinkPurpose;
}) => Promise<'changed' | 'stale'>;

/** Server-side subject of an email-change token; never inside the link. */
const claimSchema = z.object({
  userId: z.string(),
  email: z.string(),
  newEmail: z.string(),
});
type Claim = z.infer<typeof claimSchema>;

const CHANGE_UNAVAILABLE =
  'Changing your email is temporarily unavailable. Please try again shortly.';

const NEW_ADDRESS_REFUSALS: SuppressionRefusals = {
  unavailable: CHANGE_UNAVAILABLE,
  undeliverable: {
    code: EMAIL_UNDELIVERABLE,
    message: 'We cannot send email to that address. Use a different address.',
  },
};

/**
 * ISSUE-113: the address on file cannot receive the approval notice, so a
 * different new address would not help.
 */
const CURRENT_ADDRESS_UNDELIVERABLE: UndeliverableRefusal = {
  code: CURRENT_EMAIL_UNDELIVERABLE,
  message:
    'We cannot send email to the address on file, so this change cannot be approved by email.',
};

const CURRENT_ADDRESS_REFUSALS: SuppressionRefusals = {
  unavailable: CHANGE_UNAVAILABLE,
  undeliverable: CURRENT_ADDRESS_UNDELIVERABLE,
};

const invalidToken = () =>
  APIError.from('BAD_REQUEST', {
    code: 'INVALID_TOKEN',
    message: 'This link can no longer be used',
  });

/**
 * ISSUE-2: the recovery-email change (AUTH-5.6) on opaque stored tokens.
 * Better Auth 1.7.5's own `/change-email` and `/verify-email` put the
 * account, the new address and the step inside a signed JWT that is never
 * stored and cannot be revoked. Here each emailed link carries only a
 * 256-bit CSPRNG token; its SHA3-256 digest is stored under its purpose
 * (approve from the old inbox, then verify the new one) with the account,
 * both addresses and the expiry, and redemption consumes it atomically.
 *
 * `changeEmail` keeps Better Auth's key and path, so it replaces the core
 * endpoint outright (plugin endpoints are spread over the core set) and
 * every existing gate keyed on `/change-email` (fresh session, rate limit,
 * lifecycle event) still applies. `/verify-email` is disabled in `server.ts`.
 */
export const emailChangePlugin = (dependencies: {
  readonly origin: string;
  readonly deliver: Deliver;
  readonly clock: Clock;
  readonly completeEmailChange: CompleteEmailChange;
  readonly checkSuppression: SuppressionCheck;
}): BetterAuthPlugin => {
  const confirmLink = (token: string) => {
    const link = new URL(CONFIRM_EMAIL_PATH, dependencies.origin);
    link.searchParams.set('token', token);
    return link.toString();
  };
  const expiresAt = () =>
    new Date(
      Date.parse(dependencies.clock.now()) +
        EMAIL_CHANGE_LINK_EXPIRES_IN_SECONDS * 1000,
    );

  return {
    id: 'offense-demo-email-change',
    endpoints: {
      changeEmail: createAuthEndpoint(
        '/change-email',
        {
          method: 'POST',
          body: z.strictObject({ newEmail: z.email() }),
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          const { user } = ctx.context.session;
          const newEmail = ctx.body.newEmail.toLowerCase();
          if (newEmail === user.email.toLowerCase())
            throw APIError.from('BAD_REQUEST', {
              code: 'EMAIL_IS_THE_SAME',
              message: 'Email is the same',
            });
          // Neither check depends on whether the new address has an
          // account, so each refusal answers the same either way. A
          // suppressed address on file cannot receive the
          // approval notice (ISSUE-113, ISSUE-117). A suppressed new address
          // is refused now, before any mail, rather than after the old inbox
          // approves (ISSUE-104).
          await dependencies.checkSuppression(
            user.email,
            CURRENT_ADDRESS_REFUSALS,
          );
          await dependencies.checkSuppression(newEmail, NEW_ADDRESS_REFUSALS);
          // ISSUE-119: the new address is not looked up here. Whether or
          // not it has an account, the requester gets the same approval
          // notice from the same work; a taken address is settled at the
          // approval hop, which only its owner's inbox can observe.
          const token = await issue(ctx, 'email-change-approve', {
            userId: user.id,
            email: user.email,
            newEmail,
          });
          await sendOrUnavailable(
            dependencies.deliver,
            {
              to: user.email,
              ...renderAuthEmail({
                kind: 'email-change-notice',
                url: confirmLink(token),
              }),
            },
            CURRENT_ADDRESS_UNDELIVERABLE,
          );
          return ctx.json({ status: true });
        },
      ),
      verifyEmailChange: createAuthEndpoint(
        EMAIL_CHANGE_VERIFY_PATH,
        { method: 'POST', body: z.strictObject({ token: z.string() }) },
        async (ctx) => {
          const { token } = ctx.body;
          const approved = await consume(ctx, 'email-change-approve', token);
          if (approved) {
            // The old inbox approved: prove the new one next. A new address
            // that already has an account gets a notice instead, with no
            // link that redeems anything, and the approval answers the same
            // (ISSUE-119): its owner is told, the requester learns nothing.
            const mail = (await isTaken(ctx, approved))
              ? renderAuthEmail({
                  kind: 'email-change-taken',
                  url: new URL(
                    SECURITY_SETTINGS_PATH,
                    dependencies.origin,
                  ).toString(),
                })
              : renderAuthEmail({
                  kind: 'email-change-confirm',
                  url: confirmLink(
                    await issue(ctx, 'email-change-verify', approved),
                  ),
                });
            await sendOrUnavailable(dependencies.deliver, {
              to: approved.newEmail,
              ...mail,
            });
            return ctx.json({ status: true });
          }
          const verified = await consume(ctx, 'email-change-verify', token);
          if (!verified || (await isTaken(ctx, verified))) throw invalidToken();
          // The address switch and the revocation of every sign-in link
          // still mailed to the old address commit together (ISSUE-99).
          const completion = await dependencies.completeEmailChange({
            ...verified,
            signInPurpose: 'sign-in',
          });
          if (completion === 'stale') throw invalidToken();
          const updated = await ctx.context.internalAdapter.findUserById(
            verified.userId,
          );
          if (!updated) throw invalidToken();
          const session = await ctx.context.internalAdapter.createSession(
            verified.userId,
          );
          // Sets `newSession`, which the after hook in
          // `revokeOthersOnEmailChangePlugin` keeps while revoking the rest.
          await setSessionCookie(ctx, { session, user: updated });
          return ctx.json({ status: true });
        },
      ),
    },
  };

  async function issue(
    ctx: GenericEndpointContext,
    purpose: EmailedLinkPurpose,
    claim: Claim,
  ): Promise<string> {
    const token = generateEmailedLinkToken();
    await ctx.context.internalAdapter.createVerificationValue({
      identifier: emailedLinkIdentifier(purpose, token),
      value: JSON.stringify(claim),
      expiresAt: expiresAt(),
    });
    return token;
  }

  /**
   * Atomic, single-use and expiry-checked (Better Auth's
   * `consumeVerificationValue`). A claim whose account no longer holds the
   * old address is void: the token is spent either way. Its new address is
   * checked by the caller (`isTaken`): a taken one is never claimed.
   */
  async function consume(
    ctx: GenericEndpointContext,
    purpose: EmailedLinkPurpose,
    token: string,
  ): Promise<Claim | null> {
    const row = await ctx.context.internalAdapter.consumeVerificationValue(
      emailedLinkIdentifier(purpose, token),
    );
    if (!row) return null;
    const claim = claimSchema.parse(JSON.parse(row.value));
    const user = await ctx.context.internalAdapter.findUserById(claim.userId);
    if (!user || user.email !== claim.email) throw invalidToken();
    return claim;
  }

  /** Whether another account holds the claim's new address (ISSUE-2). */
  async function isTaken(
    ctx: GenericEndpointContext,
    claim: Claim,
  ): Promise<boolean> {
    return Boolean(
      await ctx.context.internalAdapter.findUserByEmail(claim.newEmail),
    );
  }
};

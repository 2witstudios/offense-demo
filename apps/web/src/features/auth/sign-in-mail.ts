import type { GenericEndpointContext } from 'better-auth';
import { createAppError } from '@offense-demo/errors';
import { buildConfirmLink } from './confirm-link';
import { emailedLinkIdentifier } from './emailed-link-token';
import { renderAuthEmail } from './mail/templates';
import { sendOrUnavailable, type Deliver } from './deliver-or-unavailable';
import type { AfterResponse } from './after-response';

/**
 * The magic-link plugin's `sendMagicLink`. Every link spends the global
 * ceilings (`createSignUpCeiling`), whether or not its address has an
 * account, so the ceilings' remaining capacity never depends on one
 * (ISSUE-188). With room, the link is sent for any address and a failed
 * send is the retryable 503. Past a ceiling the request is answered at
 * once, before anything that depends on the account: the account lookup,
 * the sign-in send (ISSUE-54: an existing account is still mailed) and the
 * sign-up's dropped mail and deleted token all run after the answer
 * (`afterResponse`), so neither the answer nor its timing reveals which
 * addresses have accounts (ISSUE-182, ISSUE-185, ISSUE-189).
 */
export const createSendMagicLink =
  (dependencies: {
    readonly origin: string;
    readonly deliver: Deliver;
    /** Spends the global ceilings; `false` when one is saturated. */
    readonly spendCeiling: () => Promise<boolean>;
    readonly afterResponse: AfterResponse;
    /** Runs one database step of handed-off work behind its gate. */
    readonly dbStep: <T>(step: () => Promise<T>) => Promise<T>;
  }) =>
  async (
    data: {
      readonly email: string;
      readonly url: string;
      readonly token: string;
    },
    context?: GenericEndpointContext,
  ): Promise<void> => {
    // Better Auth always passes the endpoint context; without it the
    // account lookup cannot run, so the send fails closed.
    if (!context) throw createAppError('INFRASTRUCTURE');
    const { internalAdapter } = context.context;
    const href = buildConfirmLink(dependencies.origin, data.url).toString();
    const send = () =>
      sendOrUnavailable(dependencies.deliver, {
        to: data.email,
        ...renderAuthEmail({ kind: 'sign-in', url: href }),
      });
    if (await dependencies.spendCeiling()) return send();
    const dropLink = () =>
      dependencies.dbStep(() =>
        internalAdapter.deleteVerificationByIdentifier(
          emailedLinkIdentifier('sign-in', data.token),
        ),
      );
    dependencies.afterResponse(async () => {
      const account = await dependencies.dbStep(() =>
        internalAdapter.findUserByEmail(data.email),
      );
      if (!account) {
        await dropLink();
        return;
      }
      try {
        await send();
      } catch {
        // The delivery path has already logged the failure for operators.
        await dropLink();
      }
    });
  };

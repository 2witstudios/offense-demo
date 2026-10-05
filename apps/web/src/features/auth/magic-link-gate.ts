import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { normalizeEmail } from './recipient-key';
import { safeLocalDestination } from './redirect';
import type {
  SuppressionCheck,
  SuppressionRefusals,
} from './suppression-check';
import { EMAIL_UNDELIVERABLE } from './undeliverable-codes';

type MagicLinkBody = {
  readonly email?: unknown;
  readonly callbackURL?: unknown;
  readonly newUserCallbackURL?: unknown;
  readonly errorCallbackURL?: unknown;
};

/** Local paths only: external, protocol-relative and encoded forms fail. */
function assertLocalDestinations(body: MagicLinkBody) {
  for (const destination of [
    body.callbackURL,
    body.newUserCallbackURL,
    body.errorCallbackURL,
  ])
    if (
      destination !== undefined &&
      (typeof destination !== 'string' ||
        safeLocalDestination(destination, '') === '')
    )
      throw new APIError('FORBIDDEN', {
        code: 'INVALID_CALLBACK_URL',
        message: 'Invalid callback URL',
      });
}

const SIGN_IN_REFUSALS: SuppressionRefusals = {
  unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  undeliverable: {
    code: EMAIL_UNDELIVERABLE,
    message:
      'We cannot send sign-in emails to this address. Sign in with a passkey or use a different address.',
  },
};

/**
 * Pre-send gate for `/sign-in/magic-link` (runs after the rate-limit gate):
 * destination validation and the suppression check.
 */
function createMagicLinkGate(checkSuppression: SuppressionCheck) {
  return async (body: MagicLinkBody | undefined) => {
    assertLocalDestinations(body ?? {});
    const email =
      typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
    if (!email) return;
    await checkSuppression(email, SIGN_IN_REFUSALS);
  };
}

/** Runs after the rate-limit gate: a throttled request does no lookups. */
export function createMagicLinkGatePlugin(
  checkSuppression: SuppressionCheck,
): BetterAuthPlugin {
  const gate = createMagicLinkGate(checkSuppression);
  return {
    id: 'offense-demo-magic-link-gate',
    hooks: {
      before: [
        {
          matcher: (context) => context.path === '/sign-in/magic-link',
          handler: createAuthMiddleware(async (context) => {
            await gate(context.body);
          }),
        },
      ],
    },
  };
}

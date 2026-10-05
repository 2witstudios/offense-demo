import type { ClientError } from '../../../features/auth/client-error';

/** How offering to save a passkey ended. Only `saved` is a success. */
export type PasskeyEnrollment =
  | { readonly kind: 'saved' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'stale-session' }
  | { readonly kind: 'unavailable' };

/**
 * The seam AUTH-5.x fills with the real registration ceremony. Until then it
 * reports `unavailable`, and the offer says so: enrolling is never faked.
 */
export type PasskeyEnrollmentSeam = {
  readonly enroll: () => Promise<PasskeyEnrollment>;
};

export const passkeyEnrollmentNotYetAvailable: PasskeyEnrollmentSeam = {
  enroll: () => Promise.resolve({ kind: 'unavailable' }),
};

/** The slice of the Better Auth client this seam uses. */
export type PasskeyEnrollmentClient = {
  readonly passkey: {
    readonly addPasskey: (opts?: {
      name?: string;
    }) => Promise<{ readonly error: ClientError }>;
  };
};

const CANCELLED_CODES = new Set([
  'AUTH_CANCELLED',
  'REGISTRATION_CANCELLED',
  'ERROR_CEREMONY_ABORTED',
  'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
]);

const outcomeFor = (error: ClientError): PasskeyEnrollment => {
  if (error === null) return { kind: 'saved' };
  if (error.code === 'SESSION_NOT_FRESH' || error.status === 401)
    return { kind: 'stale-session' };
  return error.code !== undefined && CANCELLED_CODES.has(error.code)
    ? { kind: 'cancelled' }
    : { kind: 'failed' };
};

/**
 * Real WebAuthn registration behind the onboarding and settings offers
 * (AUTH-5.1). `supportsPasskeys` gates browsers without the API so they see
 * `unavailable` instead of a ceremony that can never start.
 */
export function createPasskeyEnrollment({
  client,
  name,
  supportsPasskeys,
}: {
  readonly client: PasskeyEnrollmentClient;
  readonly name?: string;
  readonly supportsPasskeys: () => boolean;
}): PasskeyEnrollmentSeam {
  return {
    enroll: async () =>
      supportsPasskeys()
        ? outcomeFor(
            (await client.passkey.addPasskey(name ? { name } : {})).error,
          )
        : { kind: 'unavailable' },
  };
}

/** A seam that throws is a failure, never a false success. */
export const enrollSafely = async (
  seam: PasskeyEnrollmentSeam,
): Promise<PasskeyEnrollment> => {
  try {
    return await seam.enroll();
  } catch {
    return { kind: 'failed' };
  }
};

/** What each unfinished offer tells the person. */
export const enrollmentNotices: Readonly<
  Record<Exclude<PasskeyEnrollment['kind'], 'saved'>, string>
> = {
  unavailable:
    'Saving a passkey is not available yet, so nothing was saved. Email links keep working.',
  cancelled: 'Nothing was saved. You can try again or continue.',
  failed: 'We could not save a passkey. Email links keep working.',
  'stale-session':
    'This needs a recent sign-in. Sign in again with a passkey or email link, then retry.',
};

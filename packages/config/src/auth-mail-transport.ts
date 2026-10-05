/** The Resend fields: both set, or (local development only) both unset. */
export const MAIL_FIELDS = ['RESEND_API_KEY', 'AUTH_EMAIL_FROM'] as const;

/** Hosts whose links only the developer's own machine can follow. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/**
 * ADR 0050: the terminal mailer prints each emailed link, a bearer
 * credential, to the server's stderr. Only a development server whose
 * public origin is this machine may select it, and only when no Resend
 * credential is configured at all; every other environment (test, staging,
 * production, or a development server reachable from elsewhere) keeps
 * requiring Resend and fails closed without it.
 */
export const terminalMailerAllowed = (config: {
  readonly NODE_ENV: string;
  readonly PUBLIC_APP_URL: string;
  readonly RESEND_API_KEY?: string | undefined;
  readonly AUTH_EMAIL_FROM?: string | undefined;
}): boolean =>
  config.NODE_ENV === 'development' &&
  config.RESEND_API_KEY === undefined &&
  config.AUTH_EMAIL_FROM === undefined &&
  URL.canParse(config.PUBLIC_APP_URL) &&
  LOOPBACK_HOSTS.has(new URL(config.PUBLIC_APP_URL).hostname);

/**
 * How auth mail leaves the process: through Resend, or (local development
 * only, ADR 0050) printed to the terminal. Derived, never read from the
 * environment, so no variable can force the terminal mailer on.
 */
export type AuthMailTransport =
  | {
      readonly mailTransport: 'resend';
      readonly RESEND_API_KEY: string;
      readonly AUTH_EMAIL_FROM: string;
    }
  | { readonly mailTransport: 'terminal' };

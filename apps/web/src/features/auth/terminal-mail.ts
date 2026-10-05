import type { IdGenerator } from '@offense-demo/clock';
import type { AuthEmailMessage, AuthEmailSender } from './mail-types';

/**
 * ADR 0050: the local-development terminal mailer. Each auth email, link
 * included, is written to the developer's terminal so a first run can sign
 * in without a Resend account. The link is a bearer credential: this module
 * is the one documented exception to "never log credentials", and it
 * writes to stderr directly, never through the structured logger, which
 * stays credential-free. `readAuthConfig` selects it only for
 * NODE_ENV=development on a loopback PUBLIC_APP_URL with no Resend key.
 */

/** Every line of a printed message starts with this, so it is easy to find. */
export const DEV_MAIL_PREFIX = '[dev-mail]';

/** Where the block goes: the server's stderr unless a test injects one. */
type TerminalDestination = { readonly write: (chunk: string) => unknown };

const LINK = /https?:\/\/[^\s<>"']+/g;
// C0 and C1 control characters (ANSI escapes included): a printed message
// must never be able to drive the developer's terminal.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const RULE = '-'.repeat(60);

const clean = (line: string) => line.replace(CONTROL, '?');

/** The framed, prefixed block one message prints as. Pure. */
export const formatDevMail = (message: AuthEmailMessage): string => {
  const links = [...new Set(message.text.match(LINK) ?? [])];
  const lines = [
    RULE,
    'Auth email (development terminal mailer; not sent)',
    `To:      ${message.to}`,
    `Subject: ${message.subject}`,
    ...links.map((link) => `Link:    ${link}`),
    '',
    ...message.text.split(/\r?\n/),
    RULE,
  ];
  return `${lines
    .map((line) => `${DEV_MAIL_PREFIX} ${clean(line)}`.trimEnd())
    .join('\n')}\n`;
};

/**
 * Refuses outside development as a second line of defence behind the
 * configuration gate. The receipt is a local id (`dev-mail-…`), so the
 * delivery path records its `email_delivery` row exactly as it does for a
 * provider send; no delivery webhook ever arrives for it.
 */
export function createTerminalSender({
  nodeEnv,
  ids,
  destination = process.stderr,
}: {
  readonly nodeEnv: string;
  readonly ids: IdGenerator;
  readonly destination?: TerminalDestination;
}): AuthEmailSender {
  if (nodeEnv !== 'development')
    throw new Error('The terminal mailer is development-only');
  return {
    async send(message) {
      destination.write(formatDevMail(message));
      return { providerMessageId: `dev-mail-${ids.next()}` };
    },
  };
}

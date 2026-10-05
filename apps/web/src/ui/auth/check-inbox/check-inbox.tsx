import { Button } from '../../components/button/button';
import { Icon } from '../../components/icon/icon';
import { AuthFrame, AuthHeading } from '../auth-frame/auth-frame';
import { formatCountdown } from '../sign-in-state';
import { appConfig } from '../../../app-config';

export type CheckInboxProps = {
  readonly email: string;
  /** Time left before a resend is allowed; 0 when it is. */
  readonly resendInMs: number;
  readonly resending: boolean;
  readonly resend: () => void;
  readonly changeEmail: () => void;
};

/** The inbox step's headline, where focus lands when a link is sent. */
export const CHECK_INBOX_HEADING_ID = 'check-inbox-heading';

const nextSteps = [
  `Open the email titled “Sign in to ${appConfig.brand.displayName}”.`,
  'Select the link inside it, on any device.',
  'Confirm on the page that opens. You are signed in on that device.',
] as const;

const resendLabel = (resendInMs: number, resending: boolean): string => {
  if (resending) return 'Sending…';
  return resendInMs > 0
    ? `Resend in ${formatCountdown(resendInMs)}`
    : 'Resend link';
};

/**
 * Tells people where the link went, how long it lasts, and what to do if it
 * does not arrive. It never confirms that an account exists.
 */
export function CheckInbox({
  email,
  resendInMs,
  resending,
  resend,
  changeEmail,
}: CheckInboxProps) {
  return (
    <AuthFrame
      panel={{
        eyebrow: 'What happens next',
        title: 'Open the email, then confirm.',
        body: (
          <ol className="flex flex-col gap-4">
            {nextSteps.map((step, index) => (
              <li key={step} className="flex items-start gap-3">
                <span className="flex size-auth-step shrink-0 items-center justify-center rounded-full border border-stage-ink-muted text-sm font-bold text-stage-ink">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        ),
      }}
      footer="Opened the link on your phone? You will be signed in there, and this tab stays as it is."
    >
      <AuthHeading
        id={CHECK_INBOX_HEADING_ID}
        eyebrow="Link on its way"
        title="Check your inbox."
      >
        If <strong className="font-semibold text-ink">{email}</strong> can
        receive email, a sign-in link is on its way. It works once and expires
        in 5 minutes.
      </AuthHeading>
      <div className="flex items-start gap-3 rounded-md border border-border bg-surface p-4 text-base text-ink-muted">
        <Icon name="clock" className="mt-1 text-accent" />
        <p>
          <strong className="font-semibold text-ink">Work email?</strong>{' '}
          Filters can hold messages for a few minutes. Check spam or quarantine
          for “Sign in to {appConfig.brand.displayName}”.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={resending || resendInMs > 0}
          onClick={resend}
          className="h-auth-control"
        >
          {resendLabel(resendInMs, resending)}
        </Button>
        <Button variant="ghost" disabled={resending} onClick={changeEmail}>
          Use a different email
        </Button>
      </div>
    </AuthFrame>
  );
}

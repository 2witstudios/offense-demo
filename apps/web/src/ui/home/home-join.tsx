'use client';

import type { ReactNode } from 'react';
import { systemClock, type Clock } from '@offense-demo/clock';
import { Button } from '../components/button/button';
import { Icon } from '../components/icon/icon';
import { CheckInbox } from '../auth/check-inbox/check-inbox';
import { fieldClass } from '../auth/email-field/field-class';
import { CopyNotice } from '../auth/notice/notice';
import { signInNotices } from '../auth/sign-in-notices';
import { canRequestLink, resendRemainingMs } from '../auth/sign-in-state';
import {
  useLinkRequest,
  type RequestLinkAction,
} from '../auth/sign-in-flow/use-link-request';
import { SIGN_IN_EMAIL_ID } from '../auth/sign-in-form/sign-in-form';
import { homeSectionClass } from './home-section-class';

const NOTICE_ID = 'home-join-notice';

export type HomeJoinProps = {
  /** The sign-in page's own link request, so both surfaces answer alike. */
  readonly requestLink: RequestLinkAction;
  /** The page's introduction (its heading and tagline), above the form. */
  readonly children: ReactNode;
  /** Injected so the resend cooldown never reads ambient time. */
  readonly clock?: Clock;
};

/**
 * The home page's one-email sign-in. It is the sign-in link request, not a
 * second one: the same server action and the same reducer, so an answer here
 * is what `/sign-in` answers for the same request. The form posts without
 * JavaScript; a sent link swaps the whole introduction and form for the
 * sign-in inbox step, so the page keeps a single heading.
 */
export function HomeJoin({
  requestLink,
  children,
  clock = systemClock,
}: HomeJoinProps) {
  const { state, dispatch, now, postLink, resend, changeEmail } =
    useLinkRequest(requestLink, clock);

  if (state.step === 'check-inbox')
    return (
      <CheckInbox
        email={state.email}
        resendInMs={resendRemainingMs(
          state.sentAt,
          now > state.sentAt ? now : state.sentAt,
        )}
        resending={state.resending}
        resend={resend}
        changeEmail={changeEmail}
      />
    );
  if (state.step !== 'enter-email') return null;

  const busy = state.pending !== 'none';
  const copy =
    state.notice === undefined ? undefined : signInNotices[state.notice];
  return (
    <section className={homeSectionClass}>
      {children}
      <form
        action={postLink}
        aria-busy={busy}
        className="flex w-full flex-col gap-3"
        onSubmit={(event) => {
          if (!canRequestLink(state)) return event.preventDefault();
          dispatch({ type: 'link-requested' });
        }}
      >
        <label htmlFor={SIGN_IN_EMAIL_ID} className={fieldClass.label}>
          Email
        </label>
        <div className={fieldClass.row}>
          <input
            id={SIGN_IN_EMAIL_ID}
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={state.email}
            onChange={(event) =>
              dispatch({
                type: 'email-typed',
                email: event.currentTarget.value,
              })
            }
            disabled={busy}
            aria-invalid={state.notice === 'undeliverable' ? true : undefined}
            aria-describedby={
              state.notice === 'undeliverable' ? NOTICE_ID : undefined
            }
            className={fieldClass.input}
          />
          <Button type="submit" disabled={busy} className="h-auth-control">
            {state.pending === 'link' ? 'Sending…' : 'Email me a sign-in link'}
            <Icon name="arrowRight" size={18} />
          </Button>
        </div>
        <CopyNotice id={NOTICE_ID} copy={copy} />
      </form>
    </section>
  );
}

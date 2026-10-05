import { signInHref } from '../access/decision';
import { pageContext } from './confirm-http-shared';
import {
  confirmDocument,
  escapeHtml,
  hiddenInput,
  pageHeaders,
  type AuthFrameContent,
  type PanelContent,
} from './confirm-page-shared';
import { appConfig } from '../../app-config';

/** The product name, escaped once for these HTML strings. */
const BRAND = escapeHtml(appConfig.brand.displayName);

export const CONFIRM_PATH = '/auth/confirm';

/** The mock bolds only its lead sentence, with the rest read as plain text. */
type Notice = { readonly lead: string; readonly rest: string };

export type Hidden = {
  readonly callbackURL: string;
  readonly newUserCallbackURL?: string;
};
export type View =
  | {
      readonly kind: 'confirm';
      readonly token: string;
      readonly hidden: Hidden;
      readonly notice?: Notice;
    }
  | {
      readonly kind: 'expired';
      readonly hidden: Hidden;
      readonly notice?: string;
    }
  | { readonly kind: 'sent' };

const hiddenInputs = (hidden: Hidden) =>
  hiddenInput('callbackURL', hidden.callbackURL) +
  hiddenInput('newUserCallbackURL', hidden.newUserCallbackURL);

const noticeHtml = (notice: string | undefined) =>
  notice
    ? `<div class="af-notice" role="alert"><span class="af-notice-icon" aria-hidden="true">!</span><p><strong>${escapeHtml(notice)}</strong></p></div>`
    : '';

/** The confirm state's notice (the mock's retry copy): only the lead sentence is bold. */
const retryNoticeHtml = (notice: Notice | undefined) =>
  notice
    ? `<div class="af-notice" role="alert"><span class="af-notice-icon" aria-hidden="true">!</span><p><strong>${escapeHtml(notice.lead)}</strong> ${escapeHtml(notice.rest)}</p></div>`
    : '';

const SIGN_IN_PANEL: PanelContent = {
  kicker: 'Sign in',
  title: 'One click keeps your link yours.',
  body: 'Security scanners open links in email. Nothing happens until you press the button, so a scanner can’t use your link before you do.',
};

const RETRY_PANEL: PanelContent = {
  kicker: 'Sign in',
  title: 'One click keeps your link yours.',
  body: 'If sign‑in is briefly unavailable, the page says so and keeps your link ready to try again.',
};

const EXPIRED_PANEL: PanelContent = {
  kicker: 'Links are single-use',
  title: 'Fresh links, every time.',
  body: 'Each sign‑in link works once and only for five minutes, so a forwarded or old email can’t be used to get into your account.',
};

const SENT_PANEL: PanelContent = {
  kicker: 'Link sent',
  title: 'Nearly there.',
  body: `Open the newest email from ${appConfig.brand.displayName} on this device and select the button to finish signing in.`,
};

const confirmFrame = (
  view: Extract<View, { kind: 'confirm' }>,
): AuthFrameContent => ({
  body:
    '<p class="af-eyebrow">Sign in</p>' +
    '<h1>Finish signing in.</h1>' +
    retryNoticeHtml(view.notice) +
    // The mock's retry state has no lede: the notice takes its place.
    (view.notice
      ? ''
      : `<p class="af-lede">Select the button to sign in to ${BRAND} on this device.</p>`) +
    `<form class="af-form" method="post" action="${CONFIRM_PATH}">${hiddenInput('token', view.token)}${hiddenInputs(view.hidden)}<button class="af-btn" type="submit">Sign in to ${BRAND}</button></form>` +
    '<p class="af-why">We ask for this click so email security scanners that open links can’t use your link before you do.</p>',
  footer:
    'Didn’t request this? Close this page. Nothing happens until you select the button.',
  panel: view.notice ? RETRY_PANEL : SIGN_IN_PANEL,
});

const expiredFrame = (
  view: Extract<View, { kind: 'expired' }>,
): AuthFrameContent => ({
  body:
    '<p class="af-eyebrow af-muted">Link expired</p>' +
    '<h1>This sign‑in link can no longer be used.</h1>' +
    noticeHtml(view.notice) +
    '<p class="af-lede">Links expire after 5 minutes and work once. Enter your email and we’ll send a new one.</p>' +
    `<form class="af-form" method="post" action="${CONFIRM_PATH}">${hiddenInput('intent', 'resend')}${hiddenInputs(view.hidden)}<div class="af-field"><label for="email">Email</label><input class="af-input" id="email" name="email" type="email" autocomplete="email" placeholder="you@school.edu" required></div><button class="af-btn" type="submit">Email me a new link</button></form>` +
    `<div class="af-links"><a class="af-link" href="${escapeHtml(signInHref(view.hidden.callbackURL))}">Back to sign in</a><a class="af-link" href="${escapeHtml(view.hidden.callbackURL)}">Already signed in? Continue to ${BRAND}</a></div>`,
  footer: `Clicked the button twice? You’re probably already signed in. Use “Continue to ${BRAND}”.`,
  panel: EXPIRED_PANEL,
});

const sentFrame: AuthFrameContent = {
  body:
    '<p class="af-eyebrow">Link sent</p>' +
    '<h1>Check your inbox.</h1>' +
    `<p class="af-lede">If that address can sign in to ${BRAND}, a new link is on its way. It expires in 5 minutes.</p>` +
    '<p class="af-why"><strong>School email?</strong> Filters can hold messages for a few minutes. Check spam or quarantine before requesting another.</p>' +
    '<div class="af-links"><a class="af-link" href="/sign-in">Back to sign in</a></div>',
  footer: 'You can close this tab. The new link opens a fresh page.',
  panel: SENT_PANEL,
};

const frameFor = (view: View): AuthFrameContent =>
  ({
    confirm: confirmFrame,
    expired: expiredFrame,
    sent: () => sentFrame,
  })[view.kind](view as never);

/**
 * Matches the mock: each state gets its own tab/history title. Plain text:
 * confirmDocument escapes it, so it carries the raw name, not BRAND.
 */
const titleFor = (view: View): string => {
  const name = appConfig.brand.displayName;
  return {
    confirm: `Finish signing in · ${name}`,
    expired: `Link expired · ${name}`,
    sent: `Check your inbox · ${name}`,
  }[view.kind];
};

/** Server-rendered, script-free, with no third-party or external asset: nothing to prefetch or leak. */
export function renderConfirmPage(
  view: View,
  request: Request,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  const document = confirmDocument(
    titleFor(view),
    frameFor(view),
    pageContext(request),
  );
  return new Response(document, { status, headers: pageHeaders(extra) });
}

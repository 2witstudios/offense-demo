import { CONFIRM_EMAIL_PATH } from './email-change';
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

const BRAND = appConfig.brand.displayName;

export type EmailConfirmView =
  | { readonly kind: 'confirm'; readonly token: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'incomplete'; readonly callbackURL: string };

const PANEL: PanelContent = {
  kicker: 'Account security',
  title: 'Confirm it’s you, on both ends.',
  body: 'Changing the email on your account takes a click from the old address and the new one, so neither alone can move your account.',
};

const confirmFrame = (
  view: Extract<EmailConfirmView, { kind: 'confirm' }>,
): AuthFrameContent => ({
  body:
    '<p class="af-eyebrow">Account security</p>' +
    '<h1>Confirm this email change.</h1>' +
    '<p class="af-lede">Select the button to continue changing this account’s email.</p>' +
    `<form class="af-form" method="post" action="${CONFIRM_EMAIL_PATH}">${hiddenInput('token', view.token)}<button class="af-btn" type="submit">Continue</button></form>`,
  footer:
    'Didn’t request this? Close this page. Nothing changes until you select the button.',
  panel: PANEL,
});

const expiredFrame: AuthFrameContent = {
  body:
    '<p class="af-eyebrow af-muted">Link expired</p>' +
    '<h1>This link can no longer be used.</h1>' +
    '<p class="af-lede">It may have expired or already been used. Start the email change again from account security settings.</p>',
  footer: 'Nothing changed on your account.',
  panel: PANEL,
};

const undeliverableFrame: AuthFrameContent = {
  body:
    '<p class="af-eyebrow af-muted">Cannot receive email</p>' +
    '<h1>The new address cannot receive email.</h1>' +
    '<p class="af-lede">Mail to that address bounced or was reported, so we cannot send it the confirmation and the change cannot finish. Start the email change again from account security settings with a different address.</p>',
  footer: 'Nothing changed on your account.',
  panel: PANEL,
};

const incompleteFrame = (
  view: Extract<EmailConfirmView, { kind: 'incomplete' }>,
): AuthFrameContent => ({
  body:
    '<p class="af-eyebrow af-muted">Cleanup step failed</p>' +
    '<h1>Email changed, but a cleanup step failed.</h1>' +
    '<div class="af-notice" role="alert"><span class="af-notice-icon" aria-hidden="true">!</span><p><strong>Your new email address is verified, but we could not confirm every other session was signed out.</strong></p></div>' +
    `<div class="af-links"><a class="af-link" href="${escapeHtml(view.callbackURL)}">Continue to account security settings</a></div>`,
  footer: 'Check the sessions list once you continue.',
  panel: PANEL,
});

const frameFor = (view: EmailConfirmView): AuthFrameContent =>
  view.kind === 'confirm'
    ? confirmFrame(view)
    : view.kind === 'incomplete'
      ? incompleteFrame(view)
      : view.kind === 'undeliverable'
        ? undeliverableFrame
        : expiredFrame;

/** Server-rendered, script-free, with no third-party or external asset: nothing to prefetch or leak. */
export function renderEmailConfirmPage(
  view: EmailConfirmView,
  request: Request,
  status = 200,
  setCookies: readonly string[] = [],
): Response {
  const document = confirmDocument(
    `Confirm email · ${BRAND}`,
    frameFor(view),
    pageContext(request),
  );
  const headers = new Headers(pageHeaders());
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(document, { status, headers });
}

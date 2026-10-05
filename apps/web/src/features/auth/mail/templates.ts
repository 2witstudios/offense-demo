import { renderAuthEmailLayout } from './layout';
import { appConfig } from '../../../app-config';

const BRAND = appConfig.brand.displayName;

/**
 * Public template API (AUTH-3.9): stage 5 produces every authentication
 * message through this one function, by kind plus its safe variables. No
 * variant carries recipient data beyond the single link it authenticates or
 * points to (rule: never include the recipient's other data).
 */
export type AuthEmailInput =
  | { readonly kind: 'sign-in'; readonly url: string }
  | { readonly kind: 'passkey-added'; readonly url: string }
  | { readonly kind: 'passkey-removed'; readonly url: string }
  | { readonly kind: 'email-change-notice'; readonly url: string }
  | { readonly kind: 'email-change-confirm'; readonly url: string }
  | { readonly kind: 'email-change-taken'; readonly url: string };

export type RenderedAuthEmail = {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

/** The closing line every account email carries (`appConfig.mail`). */
const FOOTER_NOTE = appConfig.mail.footerNote;

/**
 * Same subject and body shape whichever kind of account the address
 * belongs to: the magic-link flow never looks up the account before
 * sending, so an existing and a brand-new address get identical mail
 * (rule: subject lines must not leak account state).
 */
function signIn(url: string): RenderedAuthEmail {
  return renderAuthEmailLayout({
    subject: `Sign in to ${BRAND}`,
    preheader: 'Open this link to sign in. It expires in 5 minutes.',
    eyebrow: 'Sign in',
    headline: 'One link, and you are in.',
    paragraphs: [
      `Open the link below to finish signing in to ${BRAND}.`,
      'It expires in 5 minutes and works once. If you did not request it, you can ignore this email.',
    ],
    linkLabel: `Sign in to ${BRAND}`,
    url,
    footerNote: FOOTER_NOTE,
  });
}

function passkeyAdded(url: string): RenderedAuthEmail {
  return renderAuthEmailLayout({
    subject: `A passkey was added to your ${BRAND} account`,
    preheader: `A new passkey can now sign in to your ${BRAND} account.`,
    eyebrow: 'Security update',
    headline: 'A new passkey was added.',
    paragraphs: [
      `A passkey was just added to your ${BRAND} account and can now sign in on its device.`,
      'If this was you, no action is needed. If it was not, review your account now.',
    ],
    linkLabel: 'Review your account',
    url,
    footerNote: FOOTER_NOTE,
  });
}

function passkeyRemoved(url: string): RenderedAuthEmail {
  return renderAuthEmailLayout({
    subject: `A passkey was removed from your ${BRAND} account`,
    preheader: `A passkey can no longer sign in to your ${BRAND} account.`,
    eyebrow: 'Security update',
    headline: 'A passkey was removed.',
    paragraphs: [
      `A passkey was just removed from your ${BRAND} account and can no longer sign in.`,
      'If this was you, no action is needed. If it was not, review your account now.',
    ],
    linkLabel: 'Review your account',
    url,
    footerNote: FOOTER_NOTE,
  });
}

function emailChangeNotice(url: string): RenderedAuthEmail {
  return renderAuthEmailLayout({
    subject: `Approve email change on ${BRAND}`,
    preheader: `Open this link only if you asked to change your ${BRAND} email.`,
    eyebrow: 'Security update',
    headline: 'Approve this email change?',
    paragraphs: [
      `Someone asked to change the email address on your ${BRAND} account away from this one.`,
      'If that was you, open the link below to approve it and continue to the new address. If it was not you, do not open it: ignoring this message keeps your account exactly as it is.',
    ],
    linkLabel: 'Approve the change',
    url,
    footerNote: FOOTER_NOTE,
  });
}

function emailChangeConfirm(url: string): RenderedAuthEmail {
  return renderAuthEmailLayout({
    subject: `Confirm your new ${BRAND} email`,
    preheader:
      'Open this link to confirm your new email. It expires in 5 minutes.',
    eyebrow: 'Confirm your email',
    headline: 'Confirm this is your new email.',
    paragraphs: [
      `Open the link below to confirm this address for your ${BRAND} account.`,
      'It expires in 5 minutes and works once. If you did not request it, you can ignore this email.',
    ],
    linkLabel: 'Confirm your email',
    url,
    footerNote: FOOTER_NOTE,
  });
}

/**
 * ISSUE-119: sent to an address another account asked to move to, once
 * that account's old inbox approved, when this address already has an
 * account. It stands where the confirmation link would, so the requester
 * cannot tell the two apart; its one link only points to the account's
 * security settings.
 */
function emailChangeTaken(url: string): RenderedAuthEmail {
  return renderAuthEmailLayout({
    subject: `Someone tried to use your email on ${BRAND}`,
    preheader: 'Your address stays with your account. Nothing changed.',
    eyebrow: 'Security update',
    headline: 'Your email stays yours.',
    paragraphs: [
      `Someone asked to move another ${BRAND} account to this email address. It already belongs to your account, so nothing changed.`,
      'No action is needed. If you are worried, review your account.',
    ],
    linkLabel: 'Review your account',
    url,
    footerNote: FOOTER_NOTE,
  });
}

/** The single entry point stage 5 (and stage 3) render every message through. */
export function renderAuthEmail(input: AuthEmailInput): RenderedAuthEmail {
  switch (input.kind) {
    case 'sign-in':
      return signIn(input.url);
    case 'passkey-added':
      return passkeyAdded(input.url);
    case 'passkey-removed':
      return passkeyRemoved(input.url);
    case 'email-change-notice':
      return emailChangeNotice(input.url);
    case 'email-change-confirm':
      return emailChangeConfirm(input.url);
    case 'email-change-taken':
      return emailChangeTaken(input.url);
  }
}

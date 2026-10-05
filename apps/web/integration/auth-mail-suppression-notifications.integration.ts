import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { createPasskeyFlows } from './auth-passkey-flows';
import { providerEvent } from './auth-webhook-helpers';
import { linkFrom, tokenOf } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-54 AC1: every auth mail goes through the one delivery path, and
 * that path honours suppression (ADR 0025). Before, only the sign-in link
 * checked it: the passkey notices and the email-change mails went straight
 * to the transport, so a hard-bounced or complained address kept receiving
 * them.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;
const { testApp, mailbox } = flows.account.flows;
/** A real permanent bounce, through the signed webhook, for a mail sent to `email`. */
/** Asks for each email change in turn and records its status and code. */
const changeEmailAnswers = async (
  cookie: string,
  addresses: readonly string[],
) => {
  const answers = [];
  for (const newEmail of addresses) {
    const response = await flows.changeEmail(cookie, newEmail);
    answers.push({
      status: response.status,
      code: ((await response.json()) as { code?: string }).code,
    });
  }
  return answers;
};

const hardBounce = async (email: string) => {
  const mail = mailbox.mails.filter((sent) => sent.to === email).at(-1);
  if (!mail) throw new Error('no mail was sent to that address');
  const response = await testApp.routes.mailWebhook.POST(
    providerEvent('email.bounced', mail.messageId, {
      bounceType: 'Permanent',
    }),
  );
  if (!response.ok) throw new Error(`webhook refused: ${response.status}`);
};

const mailsTo = (email: string, from: number) =>
  mailbox.mails.slice(from).filter((mail) => mail.to === email).length;

describe('ISSUE-54 notifications honour suppression', () => {
  test('a passkey added to an account whose address hard-bounced sends no notice', async () => {
    const { email, cookie } = await signUp();
    await hardBounce(email);
    const before = mailbox.mails.length;
    const { verifyResponse } = await flows.enrollPasskey(cookie, {
      name: 'Bounced phone',
    });
    const events = await flows.recordedEvents(async () => {
      const { verifyResponse: second } = await flows.enrollPasskey(cookie, {
        name: 'Bounced key',
      });
      await second.body?.cancel();
    });
    assert({
      given:
        'a suppressed account address and a real passkey registration, twice',
      should:
        'complete the registration, send nothing to the suppressed address and log the skipped send, never a failure',
      actual: {
        enrolled: verifyResponse.status,
        sent: mailsTo(email, before),
        suppressedLogged: events.includes('auth.mail.suppressed'),
        failureLogged: events.includes('auth.passkey.notification_failed'),
      },
      expected: {
        enrolled: 200,
        sent: 0,
        suppressedLogged: true,
        failureLogged: false,
      },
    });
  });

  test('an email change requested from a suppressed address sends nothing and says why, account or not at the new address', async () => {
    const { email, cookie } = await signUp();
    await hardBounce(email);
    const { email: taken } = await signUp();
    const before = mailbox.mails.length;
    const refusals = await changeEmailAnswers(cookie, [
      `${createId()}@example.test`,
      taken,
    ]);
    assert({
      given:
        'a signed-in account whose current address hard-bounced, moving to a free address and then to another account’s (ISSUE-113, ISSUE-117)',
      should:
        'refuse both with the same CURRENT_EMAIL_UNDELIVERABLE and send no approval notice',
      actual: { refusals, sent: mailbox.mails.length - before },
      expected: {
        refusals: [
          { status: 422, code: 'CURRENT_EMAIL_UNDELIVERABLE' },
          { status: 422, code: 'CURRENT_EMAIL_UNDELIVERABLE' },
        ],
        sent: 0,
      },
    });
  });

  test('an email change to a suppressed new address is refused when requested, account or not', async () => {
    const { email, cookie } = await signUp();
    // One suppressed address with no account (it hard-bounced a sign-in
    // link), one suppressed address that belongs to another account.
    const unclaimed = testApp.freshEmail();
    await flows.account.flows.requestLink(unclaimed);
    await hardBounce(unclaimed);
    const { email: claimed } = await signUp();
    await hardBounce(claimed);
    const before = mailbox.mails.length;
    const refusals = await changeEmailAnswers(cookie, [unclaimed, claimed]);
    assert({
      given:
        'a signed-in account asking to move to a suppressed address, once with no account there and once with one',
      should:
        'answer 422 EMAIL_UNDELIVERABLE both times, before any approval mail reaches the current address',
      actual: { refusals, sentToCurrent: mailsTo(email, before) },
      expected: {
        refusals: [
          { status: 422, code: 'EMAIL_UNDELIVERABLE' },
          { status: 422, code: 'EMAIL_UNDELIVERABLE' },
        ],
        sentToCurrent: 0,
      },
    });
  });

  test('an approval whose confirmation mail is refused as suppressed says the new address cannot receive email', async () => {
    const { email, cookie } = await signUp();
    // Deliverable when requested; it hard-bounces a sign-in link mailed
    // earlier before the current inbox approves.
    const newEmail = testApp.freshEmail();
    await flows.account.flows.requestLink(newEmail);
    const before = mailbox.mails.length;
    const requested = await flows.changeEmail(cookie, newEmail);
    const notice = mailbox.mails[before];
    await hardBounce(newEmail);
    const approved = await flows.confirmEmailPost(
      notice ? tokenOf(linkFrom(notice)) : '',
    );
    const page = await approved.text();
    assert({
      given:
        'an email change requested to a deliverable address that is suppressed before the current inbox approves it',
      should:
        'mail nothing to the new address and show a page saying it cannot receive email, not the expired-link page',
      actual: {
        requestStatus: requested.status,
        noticeTo: notice?.to,
        approvedStatus: approved.status,
        sentToSuppressed: mailsTo(newEmail, before),
        saysUndeliverable: page.includes('cannot receive email'),
        saysExpired: page.includes('can no longer be used'),
      },
      expected: {
        requestStatus: 200,
        noticeTo: email,
        approvedStatus: 422,
        sentToSuppressed: 0,
        saysUndeliverable: true,
        saysExpired: false,
      },
    });
  });
});

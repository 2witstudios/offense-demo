import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { createPasskeyFlows } from './auth-passkey-flows';
import {
  cookieHeader,
  emailOf,
  linkFrom,
  tokenOf,
  userIdOf,
  withSql,
} from './fixtures';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;
const { mails } = flows.account.flows.mailbox;

const sessionCountOf = (userId: string) =>
  withSql(
    (sql) =>
      sql`SELECT count(*)::int AS n FROM session WHERE user_id = ${userId}`,
  ).then((rows) => rows[0]?.n as number);

/** A second account completes its own change to `address`, both hops. */
const claimByAnotherAccount = async (address: string) => {
  const other = await signUp();
  const before = mails.length;
  await flows.changeEmail(other.cookie, address);
  await flows.confirmEmailPost(tokenOf(linkFrom(mails[before]!)));
  await flows.confirmEmailPost(tokenOf(linkFrom(mails[before + 1]!)));
  return (await userIdOf(address)) ?? '';
};

// ADR 0025: redemption refuses a claim whose account no longer holds the
// old address, or whose new address was taken in the meantime (ISSUE-2).
describe('ISSUE-2 email-change claim guards at redemption', () => {
  test('a stale approval, redeemed after the account moved to another address, changes nothing', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const before = mails.length;
    // A change to a claimed address is requested; its approval is left
    // unredeemed.
    await flows.changeEmail(cookie, `${createId()}@example.test`);
    const staleApproval = tokenOf(linkFrom(mails[before]!));
    // The account then completes a different change, so it no longer holds
    // the address the stale approval was issued for.
    const { newEmail, verifyToken } = await flows.confirmedEmailChange(cookie);
    await flows.confirmEmailPost(verifyToken);
    const mailsBefore = mails.length;
    const sessionsBefore = await sessionCountOf(uid);
    const redeemed = await flows.confirmEmailPost(staleApproval);
    assert({
      given:
        'an approval link issued before the account completed a different email change',
      should:
        'refuse it with no mail to the claimed address, no address change and no session',
      actual: {
        status: redeemed.status,
        sessionCookie: cookieHeader(redeemed),
        newMails: mails.length - mailsBefore,
        finalEmail: await emailOf(uid),
        sessionsAdded: (await sessionCountOf(uid)) - sessionsBefore,
      },
      expected: {
        status: 400,
        sessionCookie: '',
        newMails: 0,
        finalEmail: newEmail,
        sessionsAdded: 0,
      },
    });
  });

  test('an approval whose new address another account claimed meanwhile mails no verification link', async () => {
    const requester = await signUp();
    const requesterId = (await userIdOf(requester.email)) ?? '';
    const before = mails.length;
    const newEmail = `${createId()}@example.test`;
    await flows.changeEmail(requester.cookie, newEmail);
    const approval = tokenOf(linkFrom(mails[before]!));
    const otherId = await claimByAnotherAccount(newEmail);
    const mailsBefore = mails.length;
    const redeemed = await flows.confirmEmailPost(approval);
    const sent = mails.slice(mailsBefore);
    assert({
      given:
        "an approval link redeemed after another account took the change's new address",
      should:
        'mail that address only a notice with no link that redeems anything, answer as any approval does (ISSUE-119), and change nothing',
      actual: {
        status: redeemed.status,
        location: redeemed.headers.get('location'),
        sent: sent.map((mail) => ({
          to: mail.to,
          link: linkFrom(mail).pathname,
          token: tokenOf(linkFrom(mail)),
        })),
        requesterEmail: await emailOf(requesterId),
        claimedBy: await userIdOf(newEmail),
      },
      expected: {
        status: 303,
        location: '/settings/security',
        sent: [{ to: newEmail, link: '/settings/security', token: '' }],
        requesterEmail: requester.email,
        claimedBy: otherId,
      },
    });
  });

  test('a verification link whose new address another account claimed meanwhile changes nothing', async () => {
    const requester = await signUp();
    const requesterId = (await userIdOf(requester.email)) ?? '';
    const { newEmail, verifyToken } = await flows.confirmedEmailChange(
      requester.cookie,
    );
    const otherId = await claimByAnotherAccount(newEmail);
    const sessionsBefore = await sessionCountOf(requesterId);
    let redeemed!: Response;
    const events = await flows.recordedEvents(async () => {
      redeemed = await flows.confirmEmailPost(verifyToken);
    });
    assert({
      given:
        'a verification link redeemed after another account took its new address',
      should:
        'refuse it cleanly (not by a failed write), leaving both accounts on their addresses with no session issued',
      actual: {
        status: redeemed.status,
        unhandledFailure: events.includes('request.unhandled'),
        sessionCookie: cookieHeader(redeemed),
        requesterEmail: await emailOf(requesterId),
        otherEmail: await emailOf(otherId),
        sessionsAdded: (await sessionCountOf(requesterId)) - sessionsBefore,
      },
      expected: {
        status: 400,
        unhandledFailure: false,
        sessionCookie: '',
        requesterEmail: requester.email,
        otherEmail: newEmail,
        sessionsAdded: 0,
      },
    });
  });
});

// ISSUE-119: a signed-in account asking /change-email for a new address
// must not learn whether that address has an account. Before, a free
// address mailed the approval notice to the requester's own inbox and a
// taken one answered at once and mailed nothing (ADR 0025).

type Mail = (typeof mails)[number];

/** A mail as its recipient reads it, with its one link's token blanked. */
const asRead = (mail: Mail) => ({
  to: mail.to,
  subject: mail.subject,
  text: mail.text.replace(/token=[\w-]+/, 'token=…'),
});

/** Asks for a change to `newEmail`: the answer and every mail it sent. */
const requestChange = async (cookie: string, newEmail: string) => {
  const before = mails.length;
  const response = await flows.changeEmail(cookie, newEmail);
  return {
    status: response.status,
    body: await response.text(),
    sent: mails.slice(before),
  };
};

/** Redeems an approval: the confirm page's answer and every mail it sent. */
const approve = async (approval: Mail) => {
  const before = mails.length;
  const response = await flows.confirmEmailPost(tokenOf(linkFrom(approval)));
  return {
    status: response.status,
    location: response.headers.get('location'),
    cookies: response.headers.getSetCookie().length,
    sent: mails.slice(before),
  };
};

describe('ISSUE-119 an email change does not reveal whether the new address has an account', () => {
  test('a free and a taken new address get the same answer and the same mail in the requester’s inbox', async () => {
    const requester = await signUp();
    const { email: taken } = await signUp();
    const free = `${createId()}@example.test`;
    const toFree = await requestChange(requester.cookie, free);
    const toTaken = await requestChange(requester.cookie, taken);
    assert({
      given:
        'a signed-in account with a deliverable address asking the real route for a free address, then for another account’s',
      should:
        'answer both with the same status and body, and mail the requester one identical approval notice each, nothing to either new address',
      actual: {
        answers: [toTaken, toFree].map(({ status, body }) => ({
          status,
          body,
        })),
        inbox: [toTaken, toFree].map(({ sent }) => sent.map(asRead)),
      },
      expected: {
        answers: [
          { status: 200, body: '{"status":true}' },
          { status: 200, body: '{"status":true}' },
        ],
        inbox: [
          [asRead({ ...toFree.sent[0]!, to: requester.email })],
          [asRead({ ...toFree.sent[0]!, to: requester.email })],
        ],
      },
    });
  });

  test('approving either change answers the same; only the taken address’s owner hears, and nothing is claimed', async () => {
    const requester = await signUp();
    const { email: taken } = await signUp();
    const takenId = await userIdOf(taken);
    const free = `${createId()}@example.test`;
    const { sent: freeApproval } = await requestChange(requester.cookie, free);
    const { sent: takenApproval } = await requestChange(
      requester.cookie,
      taken,
    );
    const approvedFree = await approve(freeApproval[0]!);
    const approvedTaken = await approve(takenApproval[0]!);
    const answer = ({ status, location, cookies }: typeof approvedFree) => ({
      status,
      location,
      cookies,
    });
    const newInbox = ({ sent }: typeof approvedFree) =>
      sent.map((mail) => ({
        to: mail.to,
        path: linkFrom(mail).pathname,
        redeems: tokenOf(linkFrom(mail)) !== '',
      }));
    assert({
      given:
        'the requester’s own approval links for a free address and for another account’s, redeemed through the confirm page',
      should:
        'answer both alike, send the free address a confirmation link and the taken one a notice that redeems nothing, and leave the taken address with its owner',
      actual: {
        answers: [answer(approvedTaken), answer(approvedFree)],
        free: newInbox(approvedFree),
        taken: newInbox(approvedTaken),
        takenHeldBy: await userIdOf(taken),
      },
      expected: {
        answers: [answer(approvedFree), answer(approvedFree)],
        free: [{ to: free, path: '/auth/confirm-email', redeems: true }],
        taken: [{ to: taken, path: '/settings/security', redeems: false }],
        takenHeldBy: takenId,
      },
    });
  });
});

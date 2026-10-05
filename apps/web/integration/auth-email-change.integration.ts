import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { createPasskeyFlows } from './auth-passkey-flows';
import {
  cookieHeader,
  emailOf,
  linkFrom,
  origin,
  tokenOf,
  userIdOf,
  withSql,
} from './fixtures';
import { trackRevocations } from './auth-outbox-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { recordedEvents } = flows;
const { newClient } = flows.account.flows;
const { signUp } = flows.account;

const backdateSession = (token: string, hoursAgo: number) =>
  withSql(
    (sql) =>
      sql`UPDATE session SET created_at = now() - (${hoursAgo}::text || ' hours')::interval WHERE token = ${token}`,
  );

describe('AUTH-5.6 change the recovery email', () => {
  test('requesting a change and verifying the new address each emit their own lifecycle event (AUTH-6.4)', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const before = flows.account.flows.mailbox.mails.length;
    const newEmail = `${createId()}@example.test`;
    const requestEvents = await recordedEvents(async () => {
      await flows.changeEmail(cookie, newEmail);
    });
    const confirmLink = linkFrom(flows.account.flows.mailbox.mails[before]!);
    await flows.confirmEmailPost(tokenOf(confirmLink));
    const verifyLink = linkFrom(flows.account.flows.mailbox.mails[before + 1]!);
    const verifyEvents = await recordedEvents(async () => {
      await flows.confirmEmailPost(tokenOf(verifyLink));
    });
    assert({
      given:
        'a fresh session requesting a change, then verifying the new address',
      should:
        'emit auth.email_change.requested and auth.email_change.verified respectively',
      actual: {
        requested: requestEvents.includes('auth.email_change.requested'),
        verified: verifyEvents.includes('auth.email_change.verified'),
      },
      expected: { requested: true, verified: true },
    });
    void uid;
  });

  test('a fresh session completes the two-hop change, keeping the old address until the new one verifies', async () => {
    const { email, cookie, userId } = { ...(await signUp()), userId: '' };
    const uid = (await userIdOf(email)) ?? '';
    const before = flows.account.flows.mailbox.mails.length;
    const newEmail = `${createId()}@example.test`;
    const started = await flows.changeEmail(cookie, newEmail);

    const confirmMail = flows.account.flows.mailbox.mails[before];
    const confirmLink = linkFrom(confirmMail!);
    // GET only renders; it must not itself approve the change.
    const scanned = await flows.confirmEmailGet(confirmLink);
    const emailAfterScan = await emailOf(uid);
    const approved = await flows.confirmEmailPost(tokenOf(confirmLink));

    const verifyMail = flows.account.flows.mailbox.mails[before + 1];
    const verifyLink = linkFrom(verifyMail!);
    const verified = await flows.confirmEmailPost(tokenOf(verifyLink));
    const finalEmail = await emailOf(uid);

    assert({
      given:
        'a fresh session requesting an email change, approved and verified in turn',
      should:
        'start without error, leave the old address until verified, and finish on the new address',
      actual: {
        startedOk: started.ok,
        scanStatus: scanned.status,
        emailUnchangedAfterScan: emailAfterScan,
        approvedRedirected: approved.status,
        verifiedRedirected: verified.status,
        finalEmail,
      },
      expected: {
        startedOk: true,
        scanStatus: 200,
        emailUnchangedAfterScan: email,
        approvedRedirected: 303,
        verifiedRedirected: 303,
        finalEmail: newEmail,
      },
    });
    void userId;
  });

  test('completing the change notifies the old address and revokes other sessions', async () => {
    const { email, cookie } = await signUp();
    // A second, independent session for the same account before the change.
    const otherCookie = await flows.account.flows.signInAgain(email);
    const before = flows.account.flows.mailbox.mails.length;
    const newEmail = `${createId()}@example.test`;
    const userId = (await userIdOf(email)) ?? '';
    const revocations = await trackRevocations(userId);
    try {
      await flows.changeEmail(cookie, newEmail);
      const confirmMail = flows.account.flows.mailbox.mails[before];
      await flows.confirmEmailPost(tokenOf(linkFrom(confirmMail!)));
      const verifyMail = flows.account.flows.mailbox.mails[before + 1];
      const finalResponse = await flows.confirmEmailPost(
        tokenOf(linkFrom(verifyMail!)),
      );
      const newCookie = cookieHeader(finalResponse);

      assert({
        given:
          'a completed email change with a second, independent prior session',
        should:
          'notify the old address, keep the completing session live, revoke the other one and append a real session.revoked row (RT-2.2)',
        actual: {
          notifiedOldAddress: confirmMail!.to === email,
          completingSessionLive: await flows.isAuthenticated(newCookie),
          otherSessionRevoked: !(await flows.isAuthenticated(otherCookie)),
          outboxEventsAppended: await revocations.appended(),
        },
        expected: {
          notifiedOldAddress: true,
          completingSessionLive: true,
          otherSessionRevoked: true,
          outboxEventsAppended: 1,
        },
      });
    } finally {
      await revocations.cleanup();
    }
  });

  test('a stale session cannot start an email change', async () => {
    const { cookie } = await signUp();
    await backdateSession(
      (await flows.serverSession(cookie))?.session.token ?? '',
      2,
    );
    const attempt = await flows.changeEmail(
      cookie,
      `${createId()}@example.test`,
    );
    assert({
      given: 'a session created outside the fresh window',
      should: 'refuse to start an email change',
      actual: { ok: attempt.ok, status: attempt.status },
      expected: { ok: false, status: 403 },
    });
  });

  test('a conflicting email does not disclose the other account and changes nothing', async () => {
    const owner = await signUp();
    const requester = await signUp();
    const before = flows.account.flows.mailbox.mails.length;
    const attempt = await flows.changeEmail(requester.cookie, owner.email);
    assert({
      given: 'a change to an email that already belongs to another account',
      should: 'answer the same shape as success and change nothing',
      actual: {
        ok: attempt.ok,
        requesterEmailUnchanged: await emailOf(
          (await userIdOf(requester.email))!,
        ),
        noNewMailToRequester: flows.account.flows.mailbox.mails
          .slice(before)
          .every((mail) => mail.to !== owner.email),
      },
      expected: {
        ok: true,
        requesterEmailUnchanged: requester.email,
        noNewMailToRequester: true,
      },
    });
  });

  test('a replayed approval or verification link changes nothing', async () => {
    const { email, cookie } = await signUp();
    const before = flows.account.flows.mailbox.mails.length;
    const newEmail = `${createId()}@example.test`;
    await flows.changeEmail(cookie, newEmail);
    const { mails } = flows.account.flows.mailbox;
    const confirmLink = linkFrom(mails[before]!);
    await flows.confirmEmailPost(tokenOf(confirmLink));
    // Replayed while the change is still pending, so only consumption
    // (not the account having already moved) can refuse it (ISSUE-2).
    const approvalReplay = await flows.confirmEmailPost(tokenOf(confirmLink));
    const mailsAfterApprovalReplay = mails.length - before;
    const verifyLink = linkFrom(mails[before + 1]!);
    const first = await flows.confirmEmailPost(tokenOf(verifyLink));
    const replay = await flows.confirmEmailPost(tokenOf(verifyLink));
    const uid = await userIdOf(newEmail);
    assert({
      given:
        'the approval link and then the verification link each redeemed twice',
      should:
        'succeed once each, refusing the replays without a second mail or change',
      actual: {
        approvalReplayStatus: approvalReplay.status,
        mailsAfterApprovalReplay,
        firstRedirected: first.status,
        replayStatus: replay.status,
        finalEmail: uid ? await emailOf(uid) : null,
      },
      expected: {
        approvalReplayStatus: 400,
        mailsAfterApprovalReplay: 2,
        firstRedirected: 303,
        replayStatus: 400,
        finalEmail: newEmail,
      },
    });
    void email;
  });

  test('an invalid token is refused without a same-origin bypass', async () => {
    const crossOrigin =
      await flows.account.flows.testApp.routes.confirmEmail.POST(
        new Request(`${origin}/auth/confirm-email`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: 'https://attacker.example',
            [CLIENT_IP_HEADER]: newClient(),
          },
          body: new URLSearchParams({ token: 'not-a-real-token' }).toString(),
        }),
      );
    assert({
      given: 'a forged token from a foreign origin',
      should: 'be refused',
      actual: crossOrigin.ok,
      expected: false,
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { emailedLinkIdentifier } from './emailed-link-token';
import type { AuthEmailMessage } from './server';
import {
  linkIn,
  newEmail,
  oldEmail,
  signedIn,
} from './email-change.test-support';

setupRitewayBun();

describe('ISSUE-2 email change on opaque stored tokens', () => {
  test('the approval link carries only an opaque token whose SHA3-256 digest, purpose and subject are stored', async () => {
    const { db, sent, requestChange } = await signedIn();
    const response = await requestChange(newEmail);
    const link = linkIn(sent[1]);
    const token = link.searchParams.get('token') ?? '';
    const [row] = db.verification.filter((stored) =>
      String(stored.identifier).startsWith('email-change-'),
    ) as Array<{ identifier: string; value: string }>;
    const userId = (db.user[0] as { id: string }).id;
    assert({
      given: 'a signed-in, fresh session asking to change its email',
      should:
        'mail the old address a confirm link holding only an opaque 256-bit token, stored as its purpose and SHA3-256 digest with the account and both addresses',
      actual: {
        status: response.status,
        to: sent[1]?.to,
        path: link.pathname,
        params: [...link.searchParams.keys()],
        opaque256: /^[A-Za-z0-9_-]{43}$/.test(token),
        identifier: row?.identifier,
        subject: JSON.parse(row?.value ?? '{}'),
        tokenStored: JSON.stringify(db.verification).includes(token),
      },
      expected: {
        status: 200,
        to: oldEmail,
        path: '/auth/confirm-email',
        params: ['token'],
        opaque256: true,
        identifier: emailedLinkIdentifier('email-change-approve', token),
        subject: { userId, email: oldEmail, newEmail },
        tokenStored: false,
      },
    });
  });

  test('approving mails the new address a second opaque link; verifying switches the address and signs in', async () => {
    const { sent, requestChange, redeem, email } = await signedIn();
    await requestChange(newEmail);
    const approveToken = linkIn(sent[1]).searchParams.get('token') ?? '';
    const approved = await redeem(approveToken);
    const verifyLink = linkIn(sent[2]);
    const emailAfterApproval = email();
    const verified = await redeem(verifyLink.searchParams.get('token') ?? '');
    assert({
      given: 'the approval token, then the verification token it produced',
      should:
        'mail the new address only after approval, keep the old address until verification, then switch it and issue a session',
      actual: {
        approved: approved.status,
        approvedCookies: approved.headers.getSetCookie().length,
        secondTo: sent[2]?.to,
        secondParams: [...verifyLink.searchParams.keys()],
        emailAfterApproval,
        verified: verified.status,
        sessionIssued: verified.headers.getSetCookie().length > 0,
        finalEmail: email(),
      },
      expected: {
        approved: 200,
        approvedCookies: 0,
        secondTo: newEmail,
        secondParams: ['token'],
        emailAfterApproval: oldEmail,
        verified: 200,
        sessionIssued: true,
        finalEmail: newEmail,
      },
    });
  });

  test('every token is single-use and only redeems for its own purpose', async () => {
    const { sent, requestChange, redeem, email } = await signedIn();
    const signInToken = linkIn(sent[0]).searchParams.get('token') ?? '';
    await requestChange(newEmail);
    const approveToken = linkIn(sent[1]).searchParams.get('token') ?? '';
    const asEmailChange = await redeem(signInToken);
    await redeem(approveToken);
    const approvalReplay = await redeem(approveToken);
    const verifyToken = linkIn(sent[2]).searchParams.get('token') ?? '';
    await redeem(verifyToken);
    const verifyReplay = await redeem(verifyToken);
    assert({
      given:
        'a sign-in token offered to the email change, then each email-change token redeemed twice',
      should:
        'refuse the foreign-purpose token and every replay with 400, changing the address exactly once',
      actual: {
        signInTokenAsEmailChange: asEmailChange.status,
        approvalReplay: approvalReplay.status,
        mailsAfterReplay: sent.length,
        verifyReplay: verifyReplay.status,
        finalEmail: email(),
      },
      expected: {
        signInTokenAsEmailChange: 400,
        approvalReplay: 400,
        mailsAfterReplay: 3,
        verifyReplay: 400,
        finalEmail: newEmail,
      },
    });
  });

  test('the current address is refused', async () => {
    const { sent, requestChange, email } = await signedIn();
    const before = sent.length;
    const same = await requestChange(oldEmail.toUpperCase());
    assert({
      given: 'a change to the address already on file, in another case',
      should: 'refuse it without mailing anyone',
      actual: {
        same: same.status,
        mailed: sent.length - before,
        email: email(),
      },
      expected: { same: 400, mailed: 0, email: oldEmail },
    });
  });
});

/** A mail with its one link's token blanked, so two sends compare equal. */
const withoutToken = (message: AuthEmailMessage | undefined) => ({
  to: message?.to,
  subject: message?.subject,
  text: message?.text.replace(/token=[\w-]+/, 'token=…'),
});

describe('ISSUE-119 an email change does not reveal whether the new address has an account', () => {
  test('a taken and a free new address get the same answer and the same approval mail', async () => {
    const { sent, signIn, requestChange } = await signedIn();
    const takenEmail = 'taken@offense-demo.example.com';
    await signIn(takenEmail);
    const before = sent.length;
    const free = await requestChange(newEmail);
    const taken = await requestChange(takenEmail);
    assert({
      given: 'a change to a free address, then to another account’s',
      should:
        'answer both alike and mail the requester the same approval notice for each',
      actual: {
        answers: [
          [taken.status, await taken.text()],
          [free.status, await free.text()],
        ],
        mails: [withoutToken(sent[before + 1]), withoutToken(sent[before])],
      },
      expected: {
        answers: [
          [200, '{"status":true}'],
          [200, '{"status":true}'],
        ],
        mails: [withoutToken(sent[before]), withoutToken(sent[before])],
      },
    });
    assert({
      given: 'the two approval notices',
      should: 'go to the address on file, never to either new address',
      actual: sent.slice(before).map((message) => message.to),
      expected: [oldEmail, oldEmail],
    });
  });

  test('approving a change to a taken address tells its owner and changes nothing', async () => {
    const { sent, signIn, requestChange, redeem, email } = await signedIn();
    const takenEmail = 'taken@offense-demo.example.com';
    await signIn(takenEmail);
    const before = sent.length;
    await requestChange(takenEmail);
    const approved = await redeem(
      linkIn(sent[before]).searchParams.get('token') ?? '',
    );
    const notice = sent[before + 1];
    assert({
      given: 'the approval link of a change to another account’s address',
      should:
        'answer as a free approval does, and mail that address a notice whose one link redeems nothing',
      actual: {
        approved: approved.status,
        body: await approved.text(),
        to: notice?.to,
        subject: notice?.subject,
        link: linkIn(notice).toString(),
        mails: sent.length - before,
        email: email(),
      },
      expected: {
        approved: 200,
        body: '{"status":true}',
        to: takenEmail,
        subject: 'Someone tried to use your email on Offense Demo',
        link: 'http://localhost:3000/settings/security',
        mails: 2,
        email: oldEmail,
      },
    });
  });
});

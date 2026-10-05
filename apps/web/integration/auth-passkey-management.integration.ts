import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows } from './auth-passkey-flows';
import { cookieHeader, tokenOf, counts } from './fixtures';
import { uniqueName, identityUserId } from './auth-account-helpers';

import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;

describe('AUTH-5.3 list, rename and remove owned passkeys', () => {
  test('listing returns only the current account’s passkeys with names and creation metadata', async () => {
    const alice = await signUp();
    const bob = await signUp();
    await flows.enrollPasskey(alice.cookie, { name: 'Alice laptop' });
    await flows.enrollPasskey(bob.cookie, { name: 'Bob laptop' });
    const listed = await flows.listPasskeys(alice.cookie);
    const rows = (await listed.json()) as { name: string; createdAt: string }[];
    assert({
      given: 'two accounts, each with one passkey',
      should: "list only the caller's own passkey",
      actual: {
        count: rows.length,
        name: rows[0]?.name,
        hasCreatedAt: Boolean(rows[0]?.createdAt),
      },
      expected: { count: 1, name: 'Alice laptop', hasCreatedAt: true },
    });
  });

  test('rename and remove succeed for an owned passkey', async () => {
    const { email, cookie } = await signUp();
    const { credential } = await flows.enrollPasskey(cookie, {
      name: 'Old name',
    });
    const listed = await flows.listPasskeys(cookie);
    const [row] = (await listed.json()) as { id: string }[];
    const renamed = await flows.renamePasskey(cookie, row!.id, 'New name');
    const afterRename = await flows.listPasskeys(cookie);
    const [renamedRow] = (await afterRename.json()) as { name: string }[];
    const removed = await flows.deletePasskey(cookie, row!.id);
    assert({
      given: 'a passkey owned by the caller',
      should:
        'allow rename then removal, persisting the new name before removal and leaving none stored',
      actual: {
        renamed: renamed.ok,
        persistedName: renamedRow?.name,
        removed: removed.ok,
        stored: (await counts(email)).passkeys,
      },
      expected: {
        renamed: true,
        persistedName: 'New name',
        removed: true,
        stored: 0,
      },
    });
    void credential;
  });

  test("another user's credential id is refused for rename and removal", async () => {
    const alice = await signUp();
    const bob = await signUp();
    await flows.enrollPasskey(alice.cookie, { name: 'Alice laptop' });
    const listed = await flows.listPasskeys(alice.cookie);
    const [row] = (await listed.json()) as { id: string }[];
    const renamedByBob = await flows.renamePasskey(
      bob.cookie,
      row!.id,
      'Stolen',
    );
    const removedByBob = await flows.deletePasskey(bob.cookie, row!.id);
    const afterAttempts = await flows.listPasskeys(alice.cookie);
    const [aliceRow] = (await afterAttempts.json()) as { name: string }[];
    assert({
      given: "bob naming alice's credential id",
      should:
        "refuse both modifications and leave alice's credential name untouched",
      actual: {
        renameOk: renamedByBob.ok,
        removeOk: removedByBob.ok,
        aliceName: aliceRow?.name,
        stillStored: (await counts(alice.email)).passkeys,
      },
      expected: {
        renameOk: false,
        removeOk: false,
        aliceName: 'Alice laptop',
        stillStored: 1,
      },
    });
  });

  test('removing the final passkey preserves magic-link access', async () => {
    const { email, cookie } = await signUp();
    const listed = await flows.enrollPasskey(cookie, { name: 'Only one' });
    const rows = await flows.listPasskeys(cookie);
    const [row] = (await rows.json()) as { id: string }[];
    await flows.deletePasskey(cookie, row!.id);
    const { requestLink, redeem } = flows.account.flows;
    const { response, link } = await requestLink(email);
    const originalIdentity = await flows.account.sessionAs(cookie);
    const originalUserId = identityUserId(originalIdentity.identity);
    const recovered = await redeem(tokenOf(link as URL));
    const recoveredIdentity = await flows.account.sessionAs(
      cookieHeader(recovered),
    );
    assert({
      given: 'an account whose last passkey was just removed',
      should:
        'let the requested magic link actually authenticate the same account',
      actual: {
        removedFirst: listed.verifyResponse.ok,
        linkRequested: response.ok,
        stored: (await counts(email)).passkeys,
        recoveredUserId: identityUserId(recoveredIdentity.identity),
        matchesOriginal:
          identityUserId(recoveredIdentity.identity) === originalUserId,
      },
      expected: {
        removedFirst: true,
        linkRequested: true,
        stored: 0,
        recoveredUserId: originalUserId,
        matchesOriginal: true,
      },
    });
  });
});

describe('AUTH-5.4 recover from a lost passkey through verified email', () => {
  test('losing every passkey, recovering by email, dropping the lost credential, revoking other sessions and enrolling a replacement preserves identity', async () => {
    const { email, cookie: originalCookie } = await signUp();
    const username = uniqueName();
    await flows.account.claim(originalCookie, { username });
    const enrolledLost = await flows.enrollPasskey(originalCookie, {
      name: 'Lost device',
    });
    const lostRows = await flows.listPasskeys(originalCookie);
    const [lostPasskey] = (await lostRows.json()) as { id: string }[];

    const originalIdentity = await flows.account.sessionAs(originalCookie);
    const userId = identityUserId(originalIdentity.identity)!;
    // Lose every authenticator: recover through the emailed magic link, not
    // the still-valid original session.
    const { requestLink, redeem } = flows.account.flows;
    const { link } = await requestLink(email);
    const recovered = await redeem(tokenOf(link as URL));
    const recoveredCookie = cookieHeader(recovered);

    // Clean up as the recovered account: drop the lost credential, revoke
    // every other session (the pre-recovery one included), then enroll a
    // replacement — the full chained journey, not each step in isolation.
    const droppedLost = await flows.deletePasskey(
      recoveredCookie,
      lostPasskey!.id,
    );
    await flows.revokeOtherSessions(recoveredCookie);
    const enrolledReplacement = await flows.enrollPasskey(recoveredCookie, {
      name: 'Replacement device',
    });
    const finalRows = await flows.listPasskeys(recoveredCookie);
    const finalPasskeys = (await finalRows.json()) as { name: string }[];

    const recoveredIdentity = await flows.account.sessionAs(recoveredCookie);
    const originalAfterRevoke = await flows.account.sessionAs(originalCookie);
    // The account, and the `session.revoked` row `revokeOtherSessions`
    // appended to its inbox, are torn down by this file's shared afterAll.

    assert({
      given:
        'an account that loses every passkey, recovers by email, removes the lost credential, revokes its other sessions and enrolls a replacement',
      should:
        'keep the same user id and username, end the pre-recovery session and finish with only the replacement passkey stored',
      actual: {
        enrolledLostOk: enrolledLost.verifyResponse.ok,
        recoveredUserId: identityUserId(recoveredIdentity.identity),
        recoveredUsername:
          recoveredIdentity.identity.state === 'member'
            ? recoveredIdentity.identity.username
            : null,
        droppedLostOk: droppedLost.ok,
        enrolledReplacementOk: enrolledReplacement.verifyResponse.ok,
        finalPasskeyNames: finalPasskeys.map((row) => row.name),
        originalSessionState: originalAfterRevoke.identity.state,
      },
      expected: {
        enrolledLostOk: true,
        recoveredUserId: userId,
        recoveredUsername: username,
        droppedLostOk: true,
        enrolledReplacementOk: true,
        finalPasskeyNames: ['Replacement device'],
        originalSessionState: 'anonymous',
      },
    });
  });
});

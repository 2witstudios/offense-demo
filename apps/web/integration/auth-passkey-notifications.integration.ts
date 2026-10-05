import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows } from './auth-passkey-flows';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;

/** The account's own passkeys, as the real list endpoint reports them. */
const storedPasskeys = async (cookie: string) =>
  ((await (await flows.listPasskeys(cookie)).json()) as unknown[]).length;

describe('ISSUE-5 AC6 passkey add/remove security notifications', () => {
  test('registering a passkey sends a passkey-added notice to the account email', async () => {
    const carol = await signUp();
    const before = flows.account.flows.mailbox.mails.length;
    await flows.enrollPasskey(carol.cookie, { name: 'Carol phone' });
    const mail = flows.account.flows.mailbox.mails[before];
    assert({
      given: 'a real /passkey/verify-registration round-trip',
      should: 'deliver a passkey-added notice to the account address',
      actual: {
        to: mail?.to,
        subjectMentionsAdded: mail?.subject.toLowerCase().includes('added'),
      },
      expected: { to: carol.email, subjectMentionsAdded: true },
    });
  });

  test('deleting a passkey sends a passkey-removed notice to the account email', async () => {
    const dave = await signUp();
    const { verifyResponse } = await flows.enrollPasskey(dave.cookie, {
      name: 'Dave key',
    });
    const created = (await verifyResponse.clone().json()) as { id: string };
    const before = flows.account.flows.mailbox.mails.length;
    await flows.deletePasskey(dave.cookie, created.id);
    const mail = flows.account.flows.mailbox.mails[before];
    assert({
      given: 'a real /passkey/delete-passkey round-trip',
      should: 'deliver a passkey-removed notice to the account address',
      actual: {
        to: mail?.to,
        subjectMentionsRemoved: mail?.subject.toLowerCase().includes('removed'),
      },
      expected: { to: dave.email, subjectMentionsRemoved: true },
    });
  });
});

describe('ISSUE-53 passkey notices are sent only for a completed change', () => {
  const mailsTo = (...addresses: string[]) =>
    flows.account.flows.mailbox.mails.filter((mail) =>
      addresses.includes(mail.to),
    ).length;

  test('a failed registration sends no notice', async () => {
    const erin = await signUp();
    const before = mailsTo(erin.email);
    const { verifyResponse } = await flows.enrollPasskey(erin.cookie, {
      name: 'Forged origin key',
      badOrigin: 'https://evil.example',
    });
    assert({
      given:
        'a real /passkey/verify-registration whose attestation names a foreign origin',
      should: 'refuse the registration and send the account no notice',
      actual: {
        verified: verifyResponse.ok,
        stored: await storedPasskeys(erin.cookie),
        notices: mailsTo(erin.email) - before,
      },
      expected: { verified: false, stored: 0, notices: 0 },
    });
  });

  test("removing another account's credential sends no notice to either", async () => {
    const frank = await signUp();
    const grace = await signUp();
    await flows.enrollPasskey(frank.cookie, { name: 'Frank laptop' });
    const [row] = (await (await flows.listPasskeys(frank.cookie)).json()) as {
      id: string;
    }[];
    const before = mailsTo(frank.email, grace.email);
    const removed = await flows.deletePasskey(grace.cookie, row!.id);
    assert({
      given: "grace deleting frank's credential id through the real endpoint",
      should:
        "refuse it, keep frank's passkey and send no passkey-removed notice to anyone",
      actual: {
        removed: removed.ok,
        stillStored: await storedPasskeys(frank.cookie),
        notices: mailsTo(frank.email, grace.email) - before,
      },
      expected: { removed: false, stillStored: 1, notices: 0 },
    });
  });
});

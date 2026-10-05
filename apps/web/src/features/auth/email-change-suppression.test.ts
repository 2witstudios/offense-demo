import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { newEmail, oldEmail, signedIn } from './email-change.test-support';

setupRitewayBun();

describe('email change against the suppression ledger (ISSUE-104, ISSUE-113, ISSUE-117)', () => {
  test('a suppressed new address is refused at request, and a ledger outage fails closed', async () => {
    const { db, sent, ledger, suppress, requestChange, email } =
      await signedIn();
    const before = sent.length;
    const answer = async () => {
      const response = await requestChange(newEmail);
      const body = (await response.json()) as { code?: string };
      return { status: response.status, code: body.code };
    };
    suppress(newEmail, true);
    const suppressed = await answer();
    ledger.mode = 'down';
    const down = await answer();
    assert({
      given:
        'a change to an address the suppression ledger holds, then with the ledger unreachable',
      should:
        'answer 422 EMAIL_UNDELIVERABLE, then the retryable 503, mailing nothing and storing no email-change link',
      actual: {
        suppressed,
        down,
        mailed: sent.length - before,
        stored: db.verification.filter((row) =>
          String(row.identifier).startsWith('email-change-'),
        ).length,
        email: email(),
      },
      expected: {
        suppressed: { status: 422, code: 'EMAIL_UNDELIVERABLE' },
        down: { status: 503, code: 'AUTH_TEMPORARILY_UNAVAILABLE' },
        mailed: 0,
        stored: 0,
        email: oldEmail,
      },
    });
  });

  test('a suppressed current address is refused at request with its own code, whether or not the new address has an account', async () => {
    const { db, sent, suppress, signIn, requestChange, email } =
      await signedIn();
    const takenEmail = 'taken@offense-demo.example.com';
    await signIn(takenEmail);
    suppress(oldEmail, true, true);
    const before = sent.length;
    const answer = async (address: string) => {
      const response = await requestChange(address);
      const body = (await response.json()) as { code?: string };
      return { status: response.status, code: body.code };
    };
    const free = await answer(newEmail);
    const taken = await answer(takenEmail);
    assert({
      given:
        'an account whose current address the suppression ledger holds, asking to move to a free address and then to another account’s (ISSUE-113, ISSUE-117)',
      should:
        'answer 422 CURRENT_EMAIL_UNDELIVERABLE both times, before the account lookup, mailing nothing and storing no email-change link',
      actual: {
        free,
        taken,
        mailed: sent.length - before,
        stored: db.verification.filter((row) =>
          String(row.identifier).startsWith('email-change-'),
        ).length,
        email: email(),
      },
      expected: {
        free: { status: 422, code: 'CURRENT_EMAIL_UNDELIVERABLE' },
        taken: { status: 422, code: 'CURRENT_EMAIL_UNDELIVERABLE' },
        mailed: 0,
        stored: 0,
        email: oldEmail,
      },
    });
  });

  test('a current address suppressed between the request check and the approval send is refused with the same code', async () => {
    const { sent, suppress, requestChange } = await signedIn();
    // Deliverable at the request-time check, suppressed by the time the
    // approval notice goes out.
    suppress(oldEmail, false, true);
    const before = sent.length;
    const response = await requestChange(newEmail);
    const body = (await response.json()) as { code?: string };
    assert({
      given:
        'a current address the ledger suppresses after the request-time check',
      should:
        'answer 422 CURRENT_EMAIL_UNDELIVERABLE from the approval send and mail nothing',
      actual: {
        status: response.status,
        code: body.code,
        mailed: sent.length - before,
      },
      expected: {
        status: 422,
        code: 'CURRENT_EMAIL_UNDELIVERABLE',
        mailed: 0,
      },
    });
  });
});

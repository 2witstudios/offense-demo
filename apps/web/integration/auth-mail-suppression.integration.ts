import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { counts, linkFrom } from './fixtures';
import { createMailSuite, providerEvent } from './auth-webhook-helpers';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const suite = createMailSuite();
const { webhookRoute, authRoute, confirmRoute, mailbox } = suite;
const { fresh, requestLink, jsonPost, formPost } = suite;

describe('AUTH-3.6 suppression after hard delivery failures', () => {
  test('a hard bounce stops automatic resends, keeps sessions and passkey access, and offers safe guidance', async () => {
    const email = fresh();
    const first = await requestLink(email);
    const token = linkFrom(first.mail as never).searchParams.get('token') ?? '';
    const signedIn = await confirmRoute.POST(
      formPost({ token, callbackURL: '/app' }),
    );
    await webhookRoute.POST(
      providerEvent('email.bounced', first.mail?.messageId ?? '', {
        bounceType: 'Permanent',
      }),
    );
    const before = mailbox.mails.length;
    const retry = await authRoute.POST(
      jsonPost('/api/auth/sign-in/magic-link', { email }),
    );
    const retryBody = (await retry.json()) as {
      code?: string;
      message?: string;
    };
    const viaForm = await confirmRoute.POST(
      formPost({ intent: 'resend', email, callbackURL: '/app' }),
    );
    const formHtml = await viaForm.text();
    assert({
      given: 'a permanent bounce for an address with an existing account',
      should:
        'refuse further sends with safe guidance (no loop), keep the account and its session and send nothing',
      actual: {
        signedInStatus: signedIn.status,
        retryStatus: retry.status,
        code: retryBody.code,
        guidance: /passkey/i.test(retryBody.message ?? ''),
        formStatus: viaForm.status,
        formGuidance: /passkey/i.test(formHtml),
        sent: mailbox.mails.length - before,
        account: await counts(email),
      },
      expected: {
        signedInStatus: 303,
        retryStatus: 422,
        code: 'EMAIL_UNDELIVERABLE',
        guidance: true,
        formStatus: 422,
        formGuidance: true,
        sent: 0,
        account: { users: 1, sessions: 1, verifications: 0, passkeys: 0 },
      },
    });
  });

  test('complaints suppress; transient bounces and delays do not', async () => {
    const complained = fresh();
    const transient = fresh();
    const a = await requestLink(complained);
    const b = await requestLink(transient);
    await webhookRoute.POST(
      providerEvent('email.complained', a.mail?.messageId ?? ''),
    );
    await webhookRoute.POST(
      providerEvent('email.bounced', b.mail?.messageId ?? '', {
        bounceType: 'Transient',
      }),
    );
    const again = await requestLink(transient);
    const blocked = await requestLink(complained);
    assert({
      given: 'a complaint for one address and a transient bounce for another',
      should: 'block only the complained address',
      actual: {
        transientResend: again.response.status,
        complaintResend: blocked.response.status,
      },
      expected: { transientResend: 200, complaintResend: 422 },
    });
  });
});

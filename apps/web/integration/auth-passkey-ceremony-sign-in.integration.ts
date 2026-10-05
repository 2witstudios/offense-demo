import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { identityUserId } from './auth-account-helpers';
import { createPasskeyFlows, rpID } from './auth-passkey-flows';
import { cookieHeader, origin } from './fixtures';
import {
  buildAuthenticationResponse,
  createSoftwareCredential,
} from './webauthn-authenticator';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { recordedEvents } = flows;
const { signUp } = flows.account;

// Split from auth-passkey-ceremony.integration.ts (AUTH-5.1 enrollment
// stays there) to keep each file under the lint's line limit.
describe('AUTH-5.2 passkey sign-in', () => {
  test('an enrolled authenticator completes the assertion and establishes a session', async () => {
    const { cookie } = await signUp();
    const { credential } = await flows.enrollPasskey(cookie);
    const { verifyResponse } = await flows.signInWithPasskey(credential);
    const body = (await verifyResponse.json()) as { user?: { id: string } };
    const session = await flows.account.sessionAs(cookieHeader(verifyResponse));
    assert({
      given: 'a real assertion from the credential just enrolled',
      should: 'answer 200 and establish a session for the credential owner',
      actual: {
        status: verifyResponse.status,
        signedIn: typeof body.user?.id === 'string',
        sessionUserId: identityUserId(session.identity),
      },
      expected: { status: 200, signedIn: true, sessionUserId: body.user?.id },
    });
  });

  test('a malformed assertion creates no session', async () => {
    const optionsResponse = await flows.get(
      '/api/auth/passkey/generate-authenticate-options',
    );
    const malformed = await flows.post(
      '/api/auth/passkey/verify-authentication',
      { response: { id: 'not-a-real-credential', rawId: 'x', response: {} } },
      optionsResponse.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    );
    const session = await flows.account.sessionAs(cookieHeader(malformed));
    assert({
      given: 'a structurally invalid assertion for an unknown credential',
      should: 'be rejected without a session',
      actual: {
        ok: malformed.ok,
        sessionUserId: identityUserId(session.identity),
      },
      expected: { ok: false, sessionUserId: null },
    });
  });

  test('a replayed assertion (stale counter) is rejected on the second use', async () => {
    const { cookie } = await signUp();
    const { credential } = await flows.enrollPasskey(cookie);
    const optionsResponse = await flows.get(
      '/api/auth/passkey/generate-authenticate-options',
    );
    const options = (await optionsResponse.json()) as { challenge: string };
    const assertion = await buildAuthenticationResponse({
      credential,
      challenge: options.challenge,
      origin,
      rpID,
    });
    const challengeCookie = optionsResponse.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const firstUse = await flows.post(
      '/api/auth/passkey/verify-authentication',
      { response: assertion },
      challengeCookie,
    );
    // The single-use challenge cookie/token is already consumed; replaying
    // the exact same assertion must fail on the second attempt.
    const replay = await flows.post(
      '/api/auth/passkey/verify-authentication',
      { response: assertion },
      challengeCookie,
    );
    // A fresh assertion over the same challenge has a higher counter than
    // `assertion`, so a stale-counter check alone would let it through.
    // Submitting it against the already-consumed challenge cookie proves
    // the rejection comes from consumed challenge state, not a stale
    // counter on the reused `assertion` value above.
    const freshAssertion = await buildAuthenticationResponse({
      credential,
      challenge: options.challenge,
      origin,
      rpID,
    });
    const replayWithFreshCounter = await flows.post(
      '/api/auth/passkey/verify-authentication',
      { response: freshAssertion },
      challengeCookie,
    );
    assert({
      given: 'the exact same assertion submitted a second time',
      should: 'succeed once and be rejected on replay',
      actual: { first: firstUse.ok, replay: replay.ok },
      expected: { first: true, replay: false },
    });
    assert({
      given:
        'a newly signed assertion over the same challenge, submitted with the already-consumed challenge cookie',
      should: 'still be rejected because the challenge itself was consumed',
      actual: { replayWithFreshCounter: replayWithFreshCounter.ok },
      expected: { replayWithFreshCounter: false },
    });
  });

  test('a completed assertion emits the authenticated lifecycle event (AUTH-6.4)', async () => {
    const { cookie } = await signUp();
    const { credential } = await flows.enrollPasskey(cookie);
    const events = await recordedEvents(async () => {
      await flows.signInWithPasskey(credential);
    });
    assert({
      given: 'a real passkey assertion that succeeds',
      should: 'emit auth.passkey.authenticated',
      actual: events.filter((event) => event.startsWith('auth.passkey.')),
      expected: ['auth.passkey.authenticated'],
    });
  });

  test('an unenrolled credential id is rejected', async () => {
    const credential = await createSoftwareCredential();
    const { verifyResponse } = await flows.signInWithPasskey(credential);
    assert({
      given: 'an assertion for a credential id nobody registered',
      should: 'be rejected without a session',
      actual: verifyResponse.ok,
      expected: false,
    });
  });

  const foreignAssertions = [
    {
      name: 'an assertion signed for another origin',
      given:
        'an assertion whose clientData names a foreign origin, for a credential that is enrolled',
      tamper: { badOrigin: 'https://attacker.example' },
    },
    {
      name: 'an assertion whose authenticator data carries another RP ID hash',
      given:
        'an assertion whose authenticatorData rpIdHash names a foreign relying party, for a credential that is enrolled',
      tamper: { badRpID: 'attacker.example' },
    },
  ] as const;

  for (const { name, given, tamper } of foreignAssertions)
    test(`${name} creates no session (ISSUE-160)`, async () => {
      const { cookie } = await signUp();
      const { credential } = await flows.enrollPasskey(cookie);
      const before = (await flows.listSessions(cookie)).length;
      const { verifyResponse } = await flows.signInWithPasskey(
        credential,
        tamper,
      );
      const session = await flows.account.sessionAs(
        cookieHeader(verifyResponse),
      );
      assert({
        given,
        should:
          "be rejected, set no working cookie and add no row to the account's sessions",
        actual: {
          ok: verifyResponse.ok,
          sessionUserId: identityUserId(session.identity),
          sessionsAdded: (await flows.listSessions(cookie)).length - before,
        },
        expected: { ok: false, sessionUserId: null, sessionsAdded: 0 },
      });
    });
});

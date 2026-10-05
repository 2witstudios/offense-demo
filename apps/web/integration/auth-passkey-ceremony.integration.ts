import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows, rpID } from './auth-passkey-flows';
import { counts, origin } from './fixtures';
import { buildRegistrationResponse } from './webauthn-authenticator';
import { requireTestServices } from '@offense-demo/config';

// AUTH-5.2 (sign-in) is split into
// auth-passkey-ceremony-sign-in.integration.ts to keep each file under the
// lint's line limit.

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { recordedEvents } = flows;
const { signUp } = flows.account;

describe('AUTH-5.1 passkey enrollment', () => {
  test('a fresh verified session completes a real registration and persists only public credential data', async () => {
    const { email, cookie } = await signUp();
    const { verifyResponse } = await flows.enrollPasskey(cookie, {
      name: 'Laptop',
    });
    const body = (await verifyResponse.json()) as {
      id: string;
      name: string;
      publicKey: string;
    };
    assert({
      given: 'a freshly signed-in account completing a real WebAuthn ceremony',
      should:
        'return 200 with the stored passkey and persist exactly one credential',
      actual: {
        status: verifyResponse.status,
        name: body.name,
        hasPublicKey:
          typeof body.publicKey === 'string' && body.publicKey.length > 0,
        stored: (await counts(email)).passkeys,
      },
      expected: { status: 200, name: 'Laptop', hasPublicKey: true, stored: 1 },
    });
  });

  test('additional passkeys can be added to an account that already has one', async () => {
    const { email, cookie } = await signUp();
    await flows.enrollPasskey(cookie, { name: 'Laptop' });
    const second = await flows.enrollPasskey(cookie, { name: 'Phone' });
    assert({
      given: 'a second registration ceremony for the same account',
      should: 'succeed and leave both credentials stored',
      actual: {
        status: second.verifyResponse.status,
        stored: (await counts(email)).passkeys,
      },
      expected: { status: 200, stored: 2 },
    });
  });

  test('registration options prefer the device without excluding roaming keys', async () => {
    const { cookie } = await signUp();
    const optionsResponse = await flows.get(
      '/api/auth/passkey/generate-register-options',
      cookie,
    );
    const options = (await optionsResponse.json()) as {
      hints?: unknown;
      authenticatorSelection?: Record<string, unknown>;
    };
    assert({
      given: 'a signed-in registration-options request',
      should:
        'hint the device authenticator first, require a discoverable credential, and leave the attachment open',
      actual: {
        hints: options.hints,
        attachment: options.authenticatorSelection?.['authenticatorAttachment'],
        residentKey: options.authenticatorSelection?.['residentKey'],
      },
      expected: {
        hints: ['client-device'],
        attachment: undefined,
        residentKey: 'required',
      },
    });
  });

  test('registering without a session is rejected and stores no credential', async () => {
    const { email } = await signUp();
    const optionsResponse = await flows.get(
      '/api/auth/passkey/generate-register-options',
    );
    assert({
      given: 'no session cookie on the registration-options request',
      should: 'reject before a challenge is ever issued, and store nothing',
      actual: {
        status: optionsResponse.status,
        stored: (await counts(email)).passkeys,
      },
      expected: { status: 401, stored: 0 },
    });
  });

  test('a wrong origin in the ceremony response is rejected and stores no credential', async () => {
    const { email, cookie } = await signUp();
    const { verifyResponse } = await flows.enrollPasskey(cookie, {
      badOrigin: 'https://attacker.example',
    });
    assert({
      given: 'a registration response whose clientData names a foreign origin',
      should: 'be rejected and leave no credential behind',
      actual: { ok: verifyResponse.ok, stored: (await counts(email)).passkeys },
      expected: { ok: false, stored: 0 },
    });
  });

  test('a wrong RP ID in the ceremony response is rejected and stores no credential (ISSUE-167)', async () => {
    const { email, cookie } = await signUp();
    const { verifyResponse } = await flows.enrollPasskey(cookie, {
      badRpID: 'attacker.example',
    });
    assert({
      given:
        'a registration response whose authenticatorData rpIdHash names a foreign relying party',
      should: 'be rejected and leave no credential behind',
      actual: { ok: verifyResponse.ok, stored: (await counts(email)).passkeys },
      expected: { ok: false, stored: 0 },
    });
  });

  test('an unissued challenge at verify is rejected and stores no credential (ISSUE-167)', async () => {
    const { email, cookie } = await signUp();
    const { verifyResponse } = await flows.enrollPasskey(cookie, {
      badChallenge: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString('base64url'),
    });
    assert({
      given:
        'a registration response signed over a challenge this session was never issued',
      should: 'be rejected and leave no credential behind',
      actual: { ok: verifyResponse.ok, stored: (await counts(email)).passkeys },
      expected: { ok: false, stored: 0 },
    });
  });

  test('a completed registration emits the enrolled lifecycle event (AUTH-6.4)', async () => {
    const { cookie } = await signUp();
    const events = await recordedEvents(async () => {
      await flows.enrollPasskey(cookie, { name: 'Laptop' });
    });
    assert({
      given: 'a real passkey registration ceremony that succeeds',
      should: 'emit auth.passkey.enrolled',
      actual: events.filter((event) => event.startsWith('auth.passkey.')),
      expected: ['auth.passkey.enrolled'],
    });
  });

  test('a duplicate credential id is rejected and does not touch the existing row', async () => {
    const { email, cookie } = await signUp();
    const first = await flows.enrollPasskey(cookie, { name: 'Laptop' });
    // Replaying the exact same attestation (same credential id) a second
    // time hits the database's unique index; the duplicate must be refused.
    const optionsResponse = await flows.get(
      '/api/auth/passkey/generate-register-options',
      cookie,
    );
    const options = (await optionsResponse.json()) as { challenge: string };
    const replay = buildRegistrationResponse({
      credential: first.credential,
      challenge: options.challenge,
      origin,
      rpID,
    });
    const duplicate = await flows.post(
      '/api/auth/passkey/verify-registration',
      { response: replay },
      [
        cookie,
        optionsResponse.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; '),
      ]
        .filter(Boolean)
        .join('; '),
    );
    assert({
      given: "a second registration replaying the first credential's id",
      should: 'be rejected and leave exactly the original credential stored',
      actual: { ok: duplicate.ok, stored: (await counts(email)).passkeys },
      expected: { ok: false, stored: 1 },
    });
  });
});

import { assert, setupRitewayBun, test } from 'riteway/bun';
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createSoftwareCredential,
} from './webauthn-authenticator';
import { requireTestServices } from '@offense-demo/config';

// This suite exercises only in-process cryptography (no database or Redis),
// but every integration-tier file declares the same guard so the evidence
// gate never mistakes a missing service for a silently skipped suite.
requireTestServices(process.env);
setupRitewayBun();

const rpID = 'localhost';
const origin = 'http://localhost';

test('the software authenticator produces a real, verifiable registration and assertion', async () => {
  const credential = await createSoftwareCredential();
  const registrationOptions = await generateRegistrationOptions({
    rpName: 'Offense Demo',
    rpID,
    userName: 'tester',
    attestationType: 'none',
  });
  const registrationResponse = buildRegistrationResponse({
    credential,
    challenge: registrationOptions.challenge,
    origin,
    rpID,
  });
  const registrationVerification = await verifyRegistrationResponse({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only shape from our builder
    response: registrationResponse as any,
    expectedChallenge: registrationOptions.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });

  const authenticationOptions = await generateAuthenticationOptions({ rpID });
  const authenticationResponse = await buildAuthenticationResponse({
    credential,
    challenge: authenticationOptions.challenge,
    origin,
    rpID,
  });
  const authenticationVerification = await verifyAuthenticationResponse({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only shape from our builder
    response: authenticationResponse as any,
    expectedChallenge: authenticationOptions.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: registrationVerification.registrationInfo!.credential.id,
      publicKey:
        registrationVerification.registrationInfo!.credential.publicKey,
      counter: registrationVerification.registrationInfo!.credential.counter,
    },
    requireUserVerification: false,
  });

  assert({
    given: 'a software-generated registration and a matching assertion',
    should: 'verify true for both, via the real @simplewebauthn/server code',
    actual: {
      registrationVerified: registrationVerification.verified,
      authenticationVerified: authenticationVerification.verified,
    },
    expected: { registrationVerified: true, authenticationVerified: true },
  });
});

import { readAuthConfig } from '@offense-demo/config';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  authTestEnv,
  composeAuthServer,
  memoryTables,
} from './auth-server.test-support';
import { magicLinkRequest } from './abuse.test-support';
import { signedIn, newEmail } from './email-change.test-support';
import { deriveRecipientSubkey, recipientKey } from './recipient-key';
import type { AuthEmailMessage } from './server';

setupRitewayBun();

// A "rotated" BETTER_AUTH_SECRET: 64 non-whitespace characters, distinct
// from authTestEnv's, and never mixed with RECIPIENT_HASH_SECRET (ISSUE-141,
// ADR 0044). Whatever this value is, the suppression ledger must not care.
const ROTATED_BETTER_AUTH_SECRET =
  '16a070d4491a6987b85e1c5b7dc27640d5eefdc1e03eedcc45ad7a1dded681eb'.slice(
    0,
    64,
  );

const suppressedAddress = 'player@offense-demo.example.com';

// The suppression row's real, already-stored hash: computed once from the
// pre-rotation secret, the same way a row already in `email_suppression`
// was hashed before any rotation happened.
const PRE_ROTATION_SUPPRESSION_KEY = recipientKey(
  deriveRecipientSubkey(authTestEnv.RECIPIENT_HASH_SECRET),
  suppressedAddress,
);

/**
 * A composed server whose suppression ledger already holds the row created
 * under the pre-rotation secret; `config` varies to simulate what changes
 * (or doesn't) across a rotation.
 */
const withSuppressedLedger = (config = readAuthConfig(authTestEnv)) => {
  const db = memoryTables();
  const sent: AuthEmailMessage[] = [];
  const key = PRE_ROTATION_SUPPRESSION_KEY;
  const server = composeAuthServer(
    {
      config,
      emailSender: { send: async (message) => void sent.push(message) },
      ledger: {
        isSuppressed: async (lookupKey) => lookupKey === key,
        record: async () => {},
      },
    },
    db,
  );
  return { server, db, sent };
};

describe('ISSUE-141: BETTER_AUTH_SECRET rotation must not desynchronize the suppression ledger', () => {
  test('AC1: a suppressed address is still refused sign-in mail after a BETTER_AUTH_SECRET rotation', async () => {
    const preRotation = withSuppressedLedger();
    const postRotation = withSuppressedLedger(
      readAuthConfig({
        ...authTestEnv,
        BETTER_AUTH_SECRET: ROTATED_BETTER_AUTH_SECRET,
      }),
    );
    const answer = async (harness: typeof preRotation) => {
      const response =
        await harness.server.instance.handler(magicLinkRequest());
      const body = (await response.json()) as { code?: string };
      return {
        status: response.status,
        code: body.code,
        sent: harness.sent.length,
      };
    };
    assert({
      given:
        'the same suppressed address looked up before and after BETTER_AUTH_SECRET rotates, RECIPIENT_HASH_SECRET unchanged',
      should: 'refuse sign-in mail identically in both configurations',
      actual: {
        before: await answer(preRotation),
        after: await answer(postRotation),
      },
      expected: {
        before: { status: 422, code: 'EMAIL_UNDELIVERABLE', sent: 0 },
        after: { status: 422, code: 'EMAIL_UNDELIVERABLE', sent: 0 },
      },
    });
  });

  test('negative control: a different RECIPIENT_HASH_SECRET (not merely a different BETTER_AUTH_SECRET) desynchronizes the ledger', async () => {
    const harness = withSuppressedLedger(
      readAuthConfig({
        ...authTestEnv,
        RECIPIENT_HASH_SECRET: 'c'.repeat(64),
      }),
    );
    const response = await harness.server.instance.handler(magicLinkRequest());
    assert({
      given:
        'a different RECIPIENT_HASH_SECRET than the one the address was suppressed under',
      should:
        'no longer recognize the address as suppressed (proves the test is not vacuous)',
      actual: { status: response.status, sent: harness.sent.length },
      expected: { status: 200, sent: 1 },
    });
  });

  test('AC1: a suppressed address is still refused an email-change request after a BETTER_AUTH_SECRET rotation', async () => {
    const { suppress, requestChange, sent } = await signedIn({
      BETTER_AUTH_SECRET: ROTATED_BETTER_AUTH_SECRET,
    });
    suppress(newEmail, true);
    const before = sent.length;
    const response = await requestChange(newEmail);
    const body = (await response.json()) as { code?: string };
    assert({
      given:
        'an address the suppression ledger holds, requested from a session composed under a rotated BETTER_AUTH_SECRET',
      should: 'still refuse the email-change mail with EMAIL_UNDELIVERABLE',
      actual: {
        status: response.status,
        code: body.code,
        mailed: sent.length - before,
      },
      expected: { status: 422, code: 'EMAIL_UNDELIVERABLE', mailed: 0 },
    });
  });
});

import { createHash } from 'node:crypto';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  EMAILED_LINK_PURPOSES,
  emailedLinkIdentifier,
  generateEmailedLinkToken,
} from './emailed-link-token';

setupRitewayBun();

const sha3 = (value: string) =>
  createHash('sha3-256').update(value).digest('hex');

describe('ISSUE-2 emailed-link tokens', () => {
  test('a fresh token is 256 CSPRNG bits, base64url, and never repeats', () => {
    const tokens = Array.from({ length: 64 }, generateEmailedLinkToken);
    assert({
      given: '64 freshly generated emailed-link tokens',
      should:
        'each be 43 base64url characters (32 bytes, at least 128 bits) and all distinct',
      actual: {
        shapes: tokens.every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)),
        bytes: Buffer.from(tokens[0] ?? '', 'base64url').length,
        distinct: new Set(tokens).size,
      },
      expected: { shapes: true, bytes: 32, distinct: 64 },
    });
  });

  test('the stored identifier is the purpose and the SHA3-256 digest, never the token', () => {
    const token = generateEmailedLinkToken();
    const identifier = emailedLinkIdentifier('email-change-verify', token);
    assert({
      given: 'a token stored for the email-change verification purpose',
      should: 'be keyed by the purpose and the SHA3-256 hex digest only',
      actual: {
        identifier,
        containsToken: identifier.includes(token),
      },
      expected: {
        identifier: `email-change-verify:${sha3(token)}`,
        containsToken: false,
      },
    });
  });

  test('one token hashes to a different identifier under every purpose', () => {
    const token = generateEmailedLinkToken();
    const identifiers = EMAILED_LINK_PURPOSES.map((purpose) =>
      emailedLinkIdentifier(purpose, token),
    );
    assert({
      given: 'the same token under each emailed-link purpose',
      should:
        'give a distinct identifier per purpose, so no token redeems outside the purpose it was issued for',
      actual: new Set(identifiers).size,
      expected: EMAILED_LINK_PURPOSES.length,
    });
  });
});

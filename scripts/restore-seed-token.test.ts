import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { emailedLinkIdentifier, randomSeedToken } from './restore-seed-token';

setupRitewayBun();

/**
 * A real staging verification row once stored this exact literal as its
 * redeemable token, publicly committed in source — a reviewer redeemed it
 * into a real session. This guards against that class of value ever coming
 * back, not only this one string.
 */
const HISTORICAL_LEAKED_TOKEN = 'restore-rehearsal-placeholder-token';

describe('randomSeedToken', () => {
  test('never returns the historical, publicly committed placeholder token', () => {
    assert({
      given: 'a freshly generated seed token',
      should: 'not equal the literal token a past version of this seed stored',
      actual: randomSeedToken() === HISTORICAL_LEAKED_TOKEN,
      expected: false,
    });
  });

  test('generates a different token on every call', () => {
    const first = randomSeedToken();
    const second = randomSeedToken();
    assert({
      given: 'two separate calls',
      should: 'return two different values',
      actual: first === second,
      expected: false,
    });
  });

  test('is not a short or fixed value — 256 bits of CSPRNG, base64url-encoded', () => {
    const token = randomSeedToken();
    assert({
      given: 'a freshly generated seed token',
      should: 'be at least 43 base64url characters (32 CSPRNG bytes)',
      actual: token.length >= 43,
      expected: true,
    });
  });

  test('contains no literal words, only base64url characters', () => {
    const token = randomSeedToken();
    assert({
      given: 'a freshly generated seed token',
      should: 'match the base64url alphabet only, never a readable placeholder',
      actual: /^[A-Za-z0-9_-]+$/.test(token),
      expected: true,
    });
  });
});

describe('emailedLinkIdentifier', () => {
  test('never includes the raw token in the stored identifier', () => {
    const token = randomSeedToken();
    const identifier = emailedLinkIdentifier('sign-in', token);
    assert({
      given: 'a token and its computed identifier',
      should: 'never contain the raw token as a substring',
      actual: identifier.includes(token),
      expected: false,
    });
  });

  test('never stores the historical leaked literal, hashed or not', () => {
    const identifier = emailedLinkIdentifier('sign-in', randomSeedToken());
    assert({
      given: "a fresh token's computed identifier",
      should:
        'differ from the identifier the historical literal token would produce',
      actual:
        identifier ===
        emailedLinkIdentifier('sign-in', HISTORICAL_LEAKED_TOKEN),
      expected: false,
    });
  });
});

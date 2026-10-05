import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { rejectionOf } from '@offense-demo/errors/testing';
import { requireProbeToken } from './probe-auth';

setupRitewayBun();

const TOKEN = 'a'.repeat(32);

describe('requireProbeToken (AUTH-7.7)', () => {
  test('accepts the exact configured bearer token', () => {
    const request = new Request('http://localhost/api/ops/alerts', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    let threw = false;
    try {
      requireProbeToken(request, TOKEN);
    } catch {
      threw = true;
    }
    assert({
      given: 'a request bearing the exact configured token',
      should: 'not throw',
      actual: threw,
      expected: false,
    });
  });

  test('refuses a missing Authorization header', async () => {
    const request = new Request('http://localhost/api/ops/alerts');
    assert({
      given: 'no Authorization header',
      should: 'refuse as AUTHENTICATION',
      actual: await rejectionOf(async () => requireProbeToken(request, TOKEN)),
      expected: { code: 'AUTHENTICATION' },
    });
  });

  test('refuses a non-Bearer scheme', async () => {
    const request = new Request('http://localhost/api/ops/alerts', {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    assert({
      given: 'a non-Bearer Authorization scheme',
      should: 'refuse as AUTHENTICATION',
      actual: await rejectionOf(async () => requireProbeToken(request, TOKEN)),
      expected: { code: 'AUTHENTICATION' },
    });
  });

  test('refuses a wrong token, even one sharing a prefix', async () => {
    const request = new Request('http://localhost/api/ops/alerts', {
      headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}b` },
    });
    assert({
      given: 'a token differing only in its last character',
      should: 'refuse as AUTHENTICATION',
      actual: await rejectionOf(async () => requireProbeToken(request, TOKEN)),
      expected: { code: 'AUTHENTICATION' },
    });
  });
});

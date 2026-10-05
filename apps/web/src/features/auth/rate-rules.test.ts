import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { CLIENT_IP_HEADER } from './client-ip';
import {
  create,
  existingAccount,
  magicLinkRequest,
} from './abuse.test-support';

setupRitewayBun();

const getSession = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/api/auth/get-session', { headers });

describe('AUTH-3.4 rules the gate hands the atomic limiter', () => {
  test('a sign-up link request carries one client bucket, its network, three recipient windows and two global ceilings', async () => {
    const { server, consumed } = create();
    await server.instance.handler(magicLinkRequest());
    const kindOf = (key: string) =>
      key.startsWith('auth:magic-link:recipient:')
        ? 'recipient'
        : key.startsWith('auth:magic-link:global:')
          ? 'global'
          : key.startsWith('auth:magic-link:net:')
            ? 'network'
            : key.startsWith('auth:client:')
              ? 'client'
              : 'other';
    assert({
      given: 'one magic-link request for an address with no account',
      should:
        'consume the client bucket, the loopback client’s /24 (AUTH-3.10), all three recipient windows and both global ceilings, never carrying the address',
      actual: {
        rulesByKind: consumed.map(({ key, rule }) => ({
          kind: kindOf(key),
          rule,
        })),
        leaksAddress: consumed.some(({ key }) => key.includes('player@')),
      },
      expected: {
        rulesByKind: [
          { kind: 'client', rule: { windowSeconds: 60, max: 3 } },
          { kind: 'network', rule: { windowSeconds: 60, max: 120 } },
          { kind: 'recipient', rule: { windowSeconds: 60, max: 3 } },
          { kind: 'recipient', rule: { windowSeconds: 3_600, max: 10 } },
          { kind: 'recipient', rule: { windowSeconds: 86_400, max: 20 } },
          { kind: 'global', rule: { windowSeconds: 60, max: 120 } },
          { kind: 'global', rule: { windowSeconds: 86_400, max: 3_000 } },
        ],
        leaksAddress: false,
      },
    });
  });

  test('a recipient exhausting the hour ceiling is denied even though the minute window just reset', async () => {
    const hourExhausted = new Set<string>();
    const { server } = create({
      limiter: () => async (key, rule) => {
        if (rule.windowSeconds === 3_600) {
          if (hourExhausted.has(key))
            return { allowed: false, retryAfterSeconds: 3_600 };
          hourExhausted.add(key);
        }
        return { allowed: true, retryAfterSeconds: 0 };
      },
    });
    const first = await server.instance.handler(magicLinkRequest());
    const second = await server.instance.handler(magicLinkRequest());
    assert({
      given:
        'a limiter whose recipient-hour bucket is already exhausted for a second send',
      should:
        'admit the first send and deny the second even though the minute window is fresh',
      actual: { first: first.status, second: second.status },
      expected: { first: 200, second: 429 },
    });
  });

  test('an email change carries its client bucket and the new address’s three recipient windows, whoever holds it (ISSUE-121)', async () => {
    const { server, db, consumed } = create();
    db.user.push(existingAccount);
    const changeTo = (newEmail: string) =>
      server.instance.handler(
        new Request('http://localhost:3000/api/auth/change-email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
          },
          body: JSON.stringify({ newEmail }),
        }),
      );
    await changeTo('player@offense-demo.example.com');
    await changeTo('free@offense-demo.example.com');
    const shapeOf = ({ key, rule }: (typeof consumed)[number]) => ({
      kind: key.startsWith('auth:email-change:recipient:')
        ? 'recipient'
        : key.startsWith('auth:client:')
          ? 'client'
          : 'other',
      rule,
    });
    const perRequest = [
      { kind: 'client', rule: { windowSeconds: 60, max: 100 } },
      { kind: 'recipient', rule: { windowSeconds: 60, max: 3 } },
      { kind: 'recipient', rule: { windowSeconds: 3_600, max: 10 } },
      { kind: 'recipient', rule: { windowSeconds: 86_400, max: 20 } },
    ];
    assert({
      given:
        'an email change to an address that has an account, then to one that has none',
      should:
        'consume the same buckets for each, keyed on the new address and never carrying it, with no global ceiling',
      actual: {
        buckets: consumed.map(shapeOf),
        leaksAddress: consumed.some(({ key }) => key.includes('@')),
      },
      expected: {
        buckets: [...perRequest, ...perRequest],
        leaksAddress: false,
      },
    });
  });

  test('every other route carries the 100 per 60 seconds default', async () => {
    const { server, consumed } = create();
    await server.instance.handler(getSession());
    assert({
      given: 'a session read',
      should: 'consume one client bucket at 100/60',
      actual: consumed.map(({ rule }) => rule),
      expected: [{ windowSeconds: 60, max: 100 }],
    });
  });

  test('only the ingress-stamped identity selects the client bucket; forwarding headers are ignored', async () => {
    const { server, consumed } = create();
    await server.instance.handler(
      magicLinkRequest({
        'x-forwarded-for': '203.0.113.99',
        'x-real-ip': '203.0.113.98',
        [CLIENT_IP_HEADER]: '198.51.100.7',
      }),
    );
    await server.instance.handler(
      magicLinkRequest({ 'x-forwarded-for': '203.0.113.99' }),
    );
    const clientKeys = consumed
      .map(({ key }) => key)
      .filter((key) => key.startsWith('auth:client:'));
    assert({
      given: 'requests with and without the ingress identity, both forging XFF',
      should:
        'key the first by the stamped identity and never by the forged headers',
      actual: {
        stamped: clientKeys[0],
        unstamped: clientKeys[1],
        forgedLeaks: clientKeys.some((key) => key.includes('203.0.113')),
      },
      expected: {
        stamped: 'auth:client:198.51.100.7:/sign-in/magic-link',
        // Without the stamp Better Auth falls back to loopback in test/dev.
        unstamped: 'auth:client:127.0.0.1:/sign-in/magic-link',
        forgedLeaks: false,
      },
    });
  });

  test('the suppression list is only consulted after the rate gate admits the request', async () => {
    const throttled = create({
      limiter: () => async () => ({ allowed: false, retryAfterSeconds: 9 }),
    });
    const admitted = create();
    const denied = await throttled.server.instance.handler(magicLinkRequest());
    await admitted.server.instance.handler(magicLinkRequest());
    assert({
      given: 'a throttled request and an admitted request',
      should:
        'answer 429 without any suppression lookup, while the admitted one performs two: the gate before a token exists, then the one delivery path every auth mail shares (ISSUE-54)',
      actual: {
        status: denied.status,
        throttledLookups: throttled.lookups.count,
        admittedLookups: admitted.lookups.count,
      },
      expected: { status: 429, throttledLookups: 0, admittedLookups: 2 },
    });
  });
});

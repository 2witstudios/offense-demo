import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { CLIENT_IP_HEADER } from './client-ip';
import {
  create,
  observableAnswer,
  existingAccount,
  magicLinkRequest,
} from './abuse.test-support';

setupRitewayBun();

const IPV6_CLIENT = '2001:db8:12ab:34cd::77';
const IPV4_CLIENT = '198.51.100.23';

const fromClient = (client: string) =>
  magicLinkRequest({ [CLIENT_IP_HEADER]: client });

describe('AUTH-3.10 aggregate magic-link limits per network', () => {
  test('a magic-link request from an IPv6 client spends its /64, its /56 and its /48', async () => {
    const { server, consumed } = create();
    await server.instance.handler(fromClient(IPV6_CLIENT));
    assert({
      given: `a magic-link request from ${IPV6_CLIENT}`,
      should:
        'consume the client (/64) bucket, then the /56 and /48 buckets, before the recipient windows, never carrying the address or the client itself',
      actual: consumed
        .filter(
          ({ key }) =>
            key.startsWith('auth:client:') ||
            key.startsWith('auth:magic-link:net:'),
        )
        .map(({ key, rule }) => ({ key, rule })),
      expected: [
        {
          key: 'auth:client:2001:0db8:12ab:34cd:0000:0000:0000:0000:/sign-in/magic-link',
          rule: { windowSeconds: 60, max: 3 },
        },
        {
          key: 'auth:magic-link:net:ipv6_56:2001:0db8:12ab:3400::/56:60',
          rule: { windowSeconds: 60, max: 30 },
        },
        {
          key: 'auth:magic-link:net:ipv6_48:2001:0db8:12ab::/48:60',
          rule: { windowSeconds: 60, max: 120 },
        },
      ],
    });
  });

  test('a magic-link request from an IPv4 client spends its address and its /24', async () => {
    const { server, consumed } = create();
    await server.instance.handler(fromClient(IPV4_CLIENT));
    assert({
      given: `a magic-link request from ${IPV4_CLIENT}`,
      should: 'consume the client bucket and the /24 bucket',
      actual: consumed
        .filter(({ key }) => key.startsWith('auth:magic-link:net:'))
        .map(({ key, rule }) => ({ key, rule })),
      expected: [
        {
          key: 'auth:magic-link:net:ipv4_24:198.51.100.0/24:60',
          rule: { windowSeconds: 60, max: 120 },
        },
      ],
    });
  });

  test('other auth routes carry no network bucket', async () => {
    const { server, consumed } = create();
    await server.instance.handler(
      new Request('http://localhost:3000/api/auth/get-session', {
        headers: { [CLIENT_IP_HEADER]: IPV6_CLIENT },
      }),
    );
    assert({
      given: 'a session read from an IPv6 client',
      should: 'spend only its per-client bucket',
      actual: consumed.some(({ key }) =>
        key.startsWith('auth:magic-link:net:'),
      ),
      expected: false,
    });
  });

  test('a /48 over its limit answers an existing and an unknown address alike, logs counts only and does no work (DEC-41)', async () => {
    const deniedAt48 = () =>
      create({
        limiter: (record) => async (key, rule) => {
          record.push({ key, rule });
          return key.startsWith('auth:magic-link:net:ipv6_48:')
            ? { allowed: false, retryAfterSeconds: 42 }
            : { allowed: true, retryAfterSeconds: 0 };
        },
      });
    const unknown = deniedAt48();
    const known = deniedAt48();
    known.db.user.push(existingAccount);
    const unknownAnswer = await observableAnswer(
      await unknown.server.instance.handler(fromClient(IPV6_CLIENT)),
    );
    const knownAnswer = await observableAnswer(
      await known.server.instance.handler(fromClient(IPV6_CLIENT)),
    );
    assert({
      given:
        'a limiter refusing the /48 bucket, for an address with and without an account',
      should:
        'answer both with the same 429 and Retry-After, log auth.rate_limit.network_denied with the scope only, and write no token',
      actual: {
        known: knownAnswer,
        status: knownAnswer.status,
        logged: known.logs.filter(
          ([event]) => event === 'auth.rate_limit.network_denied',
        ),
        tokens: [known.db.verification.length, unknown.db.verification.length],
      },
      expected: {
        known: unknownAnswer,
        status: 429,
        logged: [
          [
            'auth.rate_limit.network_denied',
            {
              operation: 'auth.rate_limit',
              path: '/sign-in/magic-link',
              scope: 'ipv6_48',
            },
            'Auth magic-link request rate limited for its network',
          ],
        ],
        tokens: [0, 0],
      },
    });
  });
});

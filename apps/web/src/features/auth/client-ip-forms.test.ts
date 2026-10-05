import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { create, magicLinkRequest } from './abuse.test-support';
import {
  CLIENT_IP_HEADER,
  FLY_CLIENT_IP_HEADER,
  deriveClientIdSubkey,
  resolveClientIp,
  stampClientIdentity,
} from './client-ip';

setupRitewayBun();

const TRUSTED_PEER = '10.0.0.7';
const TRUSTED_PROXIES = ['10.0.0.0/8'];

/**
 * ISSUE-257: every IPv4-embedding or zone-id form, and the plain address the
 * ingress must stamp for it, so none reaches Better Auth's `getIP` (which
 * would fold an embedded IPv4 into the all-zero /64) or `clientNetworks`.
 */
const forms = [
  ['::ffff:1.2.3.4', '1.2.3.4'],
  ['::ffff:0102:0304', '1.2.3.4'],
  ['::ffff:0:1.2.3.4', '1.2.3.4'],
  ['::ffff:0:5.6.7.8', '5.6.7.8'],
  ['0:0:0:0:ffff:0:0102:0304', '1.2.3.4'],
  ['::1.2.3.4', '1.2.3.4'],
  ['::5.6.7.8', '5.6.7.8'],
  ['::ffff:1.2.3.4%eth0', '1.2.3.4'],
  ['2001:db8:12ab:34cd::1%eth0', '2001:db8:12ab:34cd::1'],
] as const;

/** The address the ingress stamps for `client` arriving each way it can. */
const stampedEachWay = (client: string) => [
  resolveClientIp({ peer: client, forwardedFor: null, trustedProxies: [] }),
  resolveClientIp({
    peer: TRUSTED_PEER,
    forwardedFor: null,
    flyClientIp: client,
    trustedProxies: TRUSTED_PROXIES,
  }),
  resolveClientIp({
    peer: TRUSTED_PEER,
    forwardedFor: `198.51.100.1, ${client}`,
    trustedProxies: TRUSTED_PROXIES,
  }),
];

describe('ISSUE-257 the ingress stamps no IPv4-embedding or zone-id form', () => {
  for (const [form, plain] of forms)
    test(`${form} is stamped as ${plain} however it arrives`, () => {
      assert({
        given: `${form} as the socket peer, a trusted Fly-Client-IP and a forwarded hop`,
        should: `stamp the plain address ${plain} each way`,
        actual: stampedEachWay(form),
        expected: [plain, plain, plain],
      });
    });

  test('the loopback peer of local development is stamped unchanged', () => {
    assert({
      given: 'the socket peer ::1 with no trusted proxies',
      should: 'stamp ::1, which is in no network',
      actual: resolveClientIp({
        peer: '::1',
        forwardedFor: null,
        trustedProxies: [],
      }),
      expected: '::1',
    });
  });

  test('a stamped form spends its own client and network buckets, never a shared /48', async () => {
    const spent = async (client: string) => {
      const request = {
        socket: { remoteAddress: TRUSTED_PEER },
        headers: { [FLY_CLIENT_IP_HEADER]: client } as Record<
          string,
          string | string[] | undefined
        >,
      };
      stampClientIdentity(
        request,
        TRUSTED_PROXIES,
        deriveClientIdSubkey('a'.repeat(64)),
      );
      const { server, consumed } = create();
      await server.instance.handler(
        magicLinkRequest({
          [CLIENT_IP_HEADER]: String(request.headers[CLIENT_IP_HEADER]),
        }),
      );
      return consumed
        .map(({ key }) => key)
        .filter(
          (key) =>
            key.startsWith('auth:client:') ||
            key.startsWith('auth:magic-link:net:'),
        );
    };
    assert({
      given:
        '::ffff:0:1.2.3.4 and ::5.6.7.8 through the trusted ingress into the auth handler',
      should:
        'spend each one its own IPv4 address and /24 buckets, never the all-zero /64 or /48',
      actual: [await spent('::ffff:0:1.2.3.4'), await spent('::5.6.7.8')],
      expected: [
        [
          'auth:client:1.2.3.4:/sign-in/magic-link',
          'auth:magic-link:net:ipv4_24:1.2.3.0/24:60',
        ],
        [
          'auth:client:5.6.7.8:/sign-in/magic-link',
          'auth:magic-link:net:ipv4_24:5.6.7.0/24:60',
        ],
      ],
    });
  });
});

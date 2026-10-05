import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { clientNetworks } from './client-networks';

setupRitewayBun();

describe('clientNetworks (AUTH-3.10)', () => {
  test('an IPv6 client, as Better Auth hands it over (its /64, expanded), is in one /56 and one /48', () => {
    assert({
      given: 'the /64 2001:0db8:12ab:34cd:0000:0000:0000:0000',
      should:
        'name its /56 (the /64 with its low 8 bits cleared) and its /48 (the first three groups)',
      actual: clientNetworks('2001:0db8:12ab:34cd:0000:0000:0000:0000'),
      expected: [
        { scope: 'ipv6_56', network: '2001:0db8:12ab:3400::/56' },
        { scope: 'ipv6_48', network: '2001:0db8:12ab::/48' },
      ],
    });
  });

  test('a compressed or mixed-case IPv6 address names the same networks', () => {
    assert({
      given: '2001:DB8:12AB:34FF::1 and 2001:db8:12ab:34ee:ffff::',
      should:
        'name the same /56 and /48 for both (they share the first 56 bits)',
      actual: [
        clientNetworks('2001:DB8:12AB:34FF::1'),
        clientNetworks('2001:db8:12ab:34ee:ffff::'),
      ],
      expected: [
        [
          { scope: 'ipv6_56', network: '2001:0db8:12ab:3400::/56' },
          { scope: 'ipv6_48', network: '2001:0db8:12ab::/48' },
        ],
        [
          { scope: 'ipv6_56', network: '2001:0db8:12ab:3400::/56' },
          { scope: 'ipv6_48', network: '2001:0db8:12ab::/48' },
        ],
      ],
    });
  });

  test('an IPv4 client is in one /24', () => {
    assert({
      given: '198.51.100.23',
      should: 'name its /24',
      actual: clientNetworks('198.51.100.23'),
      expected: [{ scope: 'ipv4_24', network: '198.51.100.0/24' }],
    });
  });

  test('no client, or one that is not an IP address, is in no network', () => {
    assert({
      given:
        'no client (a request the ingress did not stamp), and a non-address',
      should: 'name no network, so only the per-client buckets apply',
      actual: [clientNetworks(null), clientNetworks('unknown')],
      expected: [[], []],
    });
  });

  test('an IPv4-mapped IPv6 address is keyed by its IPv4 /24, never an IPv6 network (AUTH-3.10.1)', () => {
    const forms = [
      '::ffff:1.2.3.4',
      '::FFFF:1.2.3.4',
      '::ffff:0102:0304',
      '0:0:0:0:0:ffff:1.2.3.4',
    ];
    assert({
      given: `the IPv4-mapped forms ${forms.join(', ')}`,
      should: 'name only the IPv4 /24 1.2.3.0/24 for each',
      actual: forms.map((form) => clientNetworks(form)),
      expected: forms.map(() => [
        { scope: 'ipv4_24' as const, network: '1.2.3.0/24' },
      ]),
    });
  });

  test('mapped addresses from different /24s never share a bucket (AUTH-3.10.1)', () => {
    assert({
      given: '::ffff:1.2.3.4 and ::ffff:5.6.7.8',
      should: 'name two different networks',
      actual:
        clientNetworks('::ffff:1.2.3.4')[0]?.network ===
        clientNetworks('::ffff:5.6.7.8')[0]?.network,
      expected: false,
    });
  });

  test('the unspecified and loopback IPv6 addresses are in no network (AUTH-3.10.1)', () => {
    assert({
      given: ':: and ::1 (never a real client through the ingress)',
      should:
        'name no network, never the one 0000:0000:0000::/48 every such client would share',
      actual: [clientNetworks('::'), clientNetworks('::1')],
      expected: [[], []],
    });
  });
  const v4 = (network: string) => [{ scope: 'ipv4_24' as const, network }];
  const v6 = (prefix: string) => [
    { scope: 'ipv6_56' as const, network: `${prefix}:3400::/56` },
    { scope: 'ipv6_48' as const, network: `${prefix}::/48` },
  ];

  /** Each IPv4-embedding or zone-id form, and the network it is its own (ISSUE-257). */
  const forms = [
    ['::ffff:0:1.2.3.4', v4('1.2.3.0/24')],
    ['::ffff:0:5.6.7.8', v4('5.6.7.0/24')],
    ['::ffff:0:0102:0304', v4('1.2.3.0/24')],
    ['0:0:0:0:ffff:0:1.2.3.4', v4('1.2.3.0/24')],
    ['::1.2.3.4', v4('1.2.3.0/24')],
    ['::5.6.7.8', v4('5.6.7.0/24')],
    ['::0102:0304', v4('1.2.3.0/24')],
    ['::ffff:1.2.3.4%eth0', v4('1.2.3.0/24')],
    ['::1.2.3.4%eth0', v4('1.2.3.0/24')],
    ['2001:db8:12ab:34cd::1%eth0', v6('2001:0db8:12ab')],
    ['2001:DB8:12AB:34CD::1%25', v6('2001:0db8:12ab')],
    ['::1%lo0', []],
    ['::%eth0', []],
  ] as const;

  for (const [form, expected] of forms)
    test(`${form} keys its own network, never a shared /48 (ISSUE-257)`, () => {
      assert({
        given: `the client form ${form}`,
        should:
          expected.length === 0
            ? 'name no network'
            : `name ${expected.map(({ network }) => network).join(' and ')}`,
        actual: clientNetworks(form),
        expected,
      });
    });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { defaultGateway, resolveTrustedProxies } from './trusted-proxies';

setupRitewayBun();

const HEADER =
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
const route = (
  destination: string,
  gateway: string,
  flags: string,
  mask: string,
) => `eth0\t${destination}\t${gateway}\t${flags}\t0\t0\t0\t${mask}\t0\t0\t0`;
const table = (...routes: string[]) => [HEADER, ...routes, ''].join('\n');

/** The route table measured on the staging machine (ISSUE-162, 2026-09-28). */
const STAGING_TABLE = table(
  route('00000000', '610313AC', '0003', '00000000'),
  route('600313AC', '00000000', '0001', 'F8FFFFFF'),
);

describe('defaultGateway()', () => {
  test('the measured Fly machine route table', () => {
    assert({
      given: "a Fly machine's /proc/net/route with one default route",
      should: 'decode its little-endian gateway to dotted IPv4',
      actual: defaultGateway(STAGING_TABLE),
      expected: '172.19.3.97',
    });
  });

  test('no default route', () => {
    assert({
      given: 'a route table with only an on-link subnet route',
      should: 'resolve no gateway',
      actual: defaultGateway(
        table(route('600313AC', '00000000', '0001', 'F8FFFFFF')),
      ),
      expected: null,
    });
  });

  test('a default route that is down or has no gateway flag', () => {
    assert({
      given: 'default routes lacking RTF_UP or RTF_GATEWAY',
      should: 'resolve no gateway',
      actual: defaultGateway(
        table(
          route('00000000', '610313AC', '0002', '00000000'),
          route('00000000', '610313AC', '0001', '00000000'),
        ),
      ),
      expected: null,
    });
  });

  test('two default routes through different gateways', () => {
    assert({
      given: 'an ambiguous table with two distinct default gateways',
      should: 'resolve no gateway rather than guess which is the proxy',
      actual: defaultGateway(
        table(
          route('00000000', '610313AC', '0003', '00000000'),
          route('00000000', '010010AC', '0003', '00000000'),
        ),
      ),
      expected: null,
    });
  });

  test('a malformed table', () => {
    assert({
      given: 'text that is not a route table',
      should: 'resolve no gateway',
      actual: defaultGateway('not a route table\nnonsense'),
      expected: null,
    });
  });
});

describe('resolveTrustedProxies()', () => {
  test('the gateway keyword with a resolved gateway', () => {
    assert({
      given: 'the gateway keyword and a resolved gateway address',
      should: 'trust exactly that one address',
      actual: resolveTrustedProxies(['gateway'], '172.19.3.97'),
      expected: { trustedProxies: ['172.19.3.97'], gatewayUnresolved: false },
    });
  });

  test('the gateway keyword with no resolvable gateway', () => {
    assert({
      given: 'the gateway keyword and no resolvable gateway',
      should: 'fail closed: trust nothing for it, and report it unresolved',
      actual: resolveTrustedProxies(['gateway'], null),
      expected: { trustedProxies: [], gatewayUnresolved: true },
    });
  });

  test('explicit addresses alongside the keyword', () => {
    assert({
      given: 'an explicit address listed with the gateway keyword',
      should: 'keep the explicit address and substitute the gateway',
      actual: resolveTrustedProxies(['127.0.0.1', 'gateway'], '172.19.3.97'),
      expected: {
        trustedProxies: ['127.0.0.1', '172.19.3.97'],
        gatewayUnresolved: false,
      },
    });
  });

  test('no keyword', () => {
    assert({
      given: 'only explicit addresses and no gateway',
      should: 'pass them through untouched and report nothing unresolved',
      actual: resolveTrustedProxies(['127.0.0.1'], null),
      expected: { trustedProxies: ['127.0.0.1'], gatewayUnresolved: false },
    });
  });
});

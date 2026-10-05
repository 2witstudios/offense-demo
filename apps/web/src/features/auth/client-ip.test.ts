import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  CLIENT_ID_HASH_HEADER,
  CLIENT_IP_HEADER,
  FLY_CLIENT_IP_HEADER,
  clientIdHash,
  deriveClientIdSubkey,
  resolveClientIp,
  stampClientIdentity,
} from './client-ip';

// Known-answer vectors, computed independently (Python hashlib.sha3_256)
// for BETTER_AUTH_SECRET = 'a' x 64 and the client 203.0.113.9.
const SECRET = 'a'.repeat(64);
const SUBKEY =
  '34fdda7811c86781a47a99160ee51451a4c33418915e369cc4a06d7df5a90a76';
const KEYED =
  '5630bc61fdecfeaed71c2c477912209c9c8626ca5dd485455024185bffa9d87b';
const UNKEYED =
  '6896eba5c88ed496934ccd4986c63e35dc5f89210f182d4dadd9b218a09337e1';

setupRitewayBun();

describe('resolveClientIp', () => {
  test('without trusted proxies only the socket peer identifies the client', () => {
    assert({
      given: 'forged forwarding headers and no trusted ingress',
      should: 'ignore them and use the connection peer',
      actual: resolveClientIp({
        peer: '203.0.113.9',
        forwardedFor: '1.2.3.4, 5.6.7.8',
        trustedProxies: [],
      }),
      expected: '203.0.113.9',
    });
  });

  test('a trusted ingress hop reveals the client from the right of the chain', () => {
    assert({
      given: 'a trusted load balancer and a spoofed left-most entry',
      should: 'return the first untrusted hop from the right, not the spoof',
      actual: resolveClientIp({
        peer: '10.0.0.7',
        forwardedFor: '6.6.6.6, 198.51.100.4',
        trustedProxies: ['10.0.0.0/8'],
      }),
      expected: '198.51.100.4',
    });
  });

  test('an untrusted peer cannot borrow forwarding headers even from a trusted range claim', () => {
    assert({
      given: 'a direct client presenting X-Forwarded-For',
      should: 'use its own address',
      actual: resolveClientIp({
        peer: '192.0.2.50',
        forwardedFor: '10.0.0.1',
        trustedProxies: ['10.0.0.0/8'],
      }),
      expected: '192.0.2.50',
    });
  });

  test('normalizes IPv4-mapped IPv6 peers and handles absent chains', () => {
    assert({
      given: 'an IPv4-mapped peer and a trusted proxy without a chain',
      should: 'resolve to the normalized peer',
      actual: [
        resolveClientIp({
          peer: '::ffff:203.0.113.9',
          forwardedFor: null,
          trustedProxies: [],
        }),
        resolveClientIp({
          peer: '10.0.0.7',
          forwardedFor: null,
          trustedProxies: ['10.0.0.0/8'],
        }),
      ],
      expected: ['203.0.113.9', '10.0.0.7'],
    });
  });

  test('malformed chain entries fall back to the trusted peer, never a caller value', () => {
    assert({
      given: 'a trusted peer with a garbage forwarded entry',
      should: 'not adopt the garbage as the client identity',
      actual: resolveClientIp({
        peer: '10.0.0.7',
        forwardedFor: 'not-an-ip',
        trustedProxies: ['10.0.0.0/8'],
      }),
      expected: '10.0.0.7',
    });
  });

  test('a missing peer yields no identity', () => {
    assert({
      given: 'a request without a socket address',
      should: 'return null',
      actual: resolveClientIp({
        peer: undefined,
        forwardedFor: '1.1.1.1',
        trustedProxies: [],
      }),
      expected: null,
    });
  });

  test("a trusted peer's Fly-Client-IP is taken directly, without walking X-Forwarded-For", () => {
    assert({
      given:
        'a trusted fly-proxy peer carrying both Fly-Client-IP and an X-Forwarded-For chain',
      should: "resolve to Fly's authoritative single value",
      actual: resolveClientIp({
        peer: 'fdaa::1',
        forwardedFor: '6.6.6.6, 198.51.100.4',
        flyClientIp: '203.0.113.9',
        trustedProxies: ['fdaa::/8'],
      }),
      expected: '203.0.113.9',
    });
  });

  test("an untrusted peer's Fly-Client-IP is never honored; zero trust falls back to the peer", () => {
    assert({
      given: 'a direct, untrusted caller forging Fly-Client-IP',
      should: 'ignore the header entirely and use its own address',
      actual: resolveClientIp({
        peer: '192.0.2.50',
        forwardedFor: null,
        flyClientIp: '198.51.100.4',
        trustedProxies: ['fdaa::/8'],
      }),
      expected: '192.0.2.50',
    });
  });

  test('a trusted peer with a malformed Fly-Client-IP falls back to walking X-Forwarded-For', () => {
    assert({
      given: 'a trusted peer whose Fly-Client-IP is not a usable address',
      should: 'ignore it and resolve the chain as before',
      actual: resolveClientIp({
        peer: '10.0.0.7',
        forwardedFor: '6.6.6.6, 198.51.100.4',
        flyClientIp: 'not-an-ip',
        trustedProxies: ['10.0.0.0/8'],
      }),
      expected: '198.51.100.4',
    });
  });

  test('a trusted peer with no Fly-Client-IP still resolves through X-Forwarded-For', () => {
    assert({
      given: 'a trusted peer sending no Fly-Client-IP header at all',
      should: 'fall back to the existing chain-walking behavior',
      actual: resolveClientIp({
        peer: '10.0.0.7',
        forwardedFor: '6.6.6.6, 198.51.100.4',
        trustedProxies: ['10.0.0.0/8'],
      }),
      expected: '198.51.100.4',
    });
  });
});

describe('clientIdHash', () => {
  test('a subkey derived from the app secret under its own label', () => {
    assert({
      given: "BETTER_AUTH_SECRET 'a' x 64",
      should:
        'derive SHA3-256(secret, NUL, "client-id-hash"), the known-answer subkey',
      actual: deriveClientIdSubkey(SECRET),
      expected: SUBKEY,
    });
  });

  test('keyed, so the IPv4 space cannot be enumerated to reverse it', () => {
    const keyed = clientIdHash(deriveClientIdSubkey(SECRET), '203.0.113.9');
    assert({
      given: 'a client address and the derived subkey',
      should:
        'equal the keyed known-answer vector and differ from the plain SHA3-256 of the address',
      actual: { keyed, differsFromUnkeyed: keyed !== UNKEYED },
      expected: { keyed: KEYED, differsFromUnkeyed: true },
    });
  });
});

describe('stampClientIdentity', () => {
  test('overwrites a caller-supplied identity header with the resolved one', () => {
    const request = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: {
        [CLIENT_IP_HEADER]: '9.9.9.9',
        'x-forwarded-for': '8.8.8.8',
      } as Record<string, string | string[] | undefined>,
    };
    stampClientIdentity(request, [], SUBKEY);
    assert({
      given: 'a caller who sets the internal identity header',
      should: 'replace it with the connection identity',
      actual: request.headers[CLIENT_IP_HEADER],
      expected: '203.0.113.9',
    });
  });

  test('removes the header when no identity can be established', () => {
    const request = {
      socket: { remoteAddress: undefined },
      headers: { [CLIENT_IP_HEADER]: '9.9.9.9' } as Record<
        string,
        string | string[] | undefined
      >,
    };
    stampClientIdentity(request, [], SUBKEY);
    assert({
      given: 'a request without a peer address',
      should: 'never leave a caller-supplied identity in place',
      actual: CLIENT_IP_HEADER in request.headers,
      expected: false,
    });
  });

  test('stamps the keyed client id hash beside the identity', () => {
    const request = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: { [CLIENT_ID_HASH_HEADER]: UNKEYED } as Record<
        string,
        string | string[] | undefined
      >,
    };
    stampClientIdentity(request, [], SUBKEY);
    assert({
      given: 'a resolved client and a caller-forged hash header',
      should: 'replace it with the keyed hash of the resolved identity',
      actual: request.headers[CLIENT_ID_HASH_HEADER],
      expected: KEYED,
    });
  });

  test('removes the hash header when no identity can be established', () => {
    const request = {
      socket: { remoteAddress: undefined },
      headers: { [CLIENT_ID_HASH_HEADER]: UNKEYED } as Record<
        string,
        string | string[] | undefined
      >,
    };
    stampClientIdentity(request, [], SUBKEY);
    assert({
      given: 'a request without a peer address and a forged hash header',
      should: 'never leave the caller-supplied hash in place',
      actual: CLIENT_ID_HASH_HEADER in request.headers,
      expected: false,
    });
  });

  test("stamps Fly's authoritative header when the peer is a trusted fly-proxy hop", () => {
    const request = {
      socket: { remoteAddress: 'fdaa::1' },
      headers: {
        [FLY_CLIENT_IP_HEADER]: '203.0.113.9',
        'x-forwarded-for': '6.6.6.6, 198.51.100.4',
      } as Record<string, string | string[] | undefined>,
    };
    stampClientIdentity(request, ['fdaa::/8'], SUBKEY);
    assert({
      given:
        'a trusted fly-proxy peer forwarding Fly-Client-IP and X-Forwarded-For',
      should:
        'stamp the identity header from Fly-Client-IP, not the forwarded chain',
      actual: request.headers[CLIENT_IP_HEADER],
      expected: '203.0.113.9',
    });
  });

  test('never honors a caller-forged Fly-Client-IP from an untrusted peer', () => {
    const request = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: {
        [FLY_CLIENT_IP_HEADER]: '198.51.100.4',
      } as Record<string, string | string[] | undefined>,
    };
    stampClientIdentity(request, ['fdaa::/8'], SUBKEY);
    assert({
      given: 'a direct, untrusted caller forging Fly-Client-IP',
      should: 'stamp the connection identity, ignoring the forged header',
      actual: request.headers[CLIENT_IP_HEADER],
      expected: '203.0.113.9',
    });
  });
});

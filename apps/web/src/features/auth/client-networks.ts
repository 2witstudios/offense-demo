import { isIP } from 'node:net';

/** The networks a client's magic-link requests are also counted per (AUTH-3.10). */
export type NetworkScope = 'ipv6_56' | 'ipv6_48' | 'ipv4_24';

export type ClientNetwork = {
  readonly scope: NetworkScope;
  /** The network in CIDR form: never the client's own address. */
  readonly network: string;
};

/**
 * An IPv6 address's eight groups, each four lowercase hex digits, with an
 * embedded IPv4 tail (`::ffff:1.2.3.4`) turned into its two groups.
 */
const ipv6Groups = (address: string): string[] => {
  const lower = address.toLowerCase();
  const dotted = lower.lastIndexOf(':');
  const tail = lower.slice(dotted + 1);
  const hex =
    isIP(tail) === 4
      ? (() => {
          const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
          const group = (high: number, low: number) =>
            ((high << 8) | low).toString(16);
          return `${lower.slice(0, dotted + 1)}${group(a, b)}:${group(c, d)}`;
        })()
      : lower;
  const [left = '', right] = hex.split('::');
  const head = left ? left.split(':') : [];
  const rest = right ? right.split(':') : [];
  const zeros = Array.from(
    { length: right === undefined ? 0 : 8 - head.length - rest.length },
    () => '0',
  );
  return [...head, ...zeros, ...rest].map((group) => group.padStart(4, '0'));
};

const zeros = (groups: readonly string[]) =>
  groups.every((group) => group === '0000');

/**
 * Whether an IPv6 address embeds an IPv4 one in its low 32 bits: mapped
 * (`::ffff:0:0/96`), SIIT-translated (`::ffff:0:0:0/96`) or IPv4-compatible
 * (`::/96`, except `::`, `::1` and the rest of `::/112`, which carry no
 * address).
 */
const embedsIPv4 = (groups: readonly string[]): boolean => {
  const [, , , , g4, g5, g6] = groups;
  if (zeros(groups.slice(0, 4)) && g4 === 'ffff' && g5 === '0000') return true;
  if (!zeros(groups.slice(0, 5))) return false;
  return g5 === 'ffff' || (g5 === '0000' && g6 !== '0000');
};

const embeddedIPv4 = (groups: readonly string[]): string =>
  [groups[6] ?? '0000', groups[7] ?? '0000']
    .flatMap((group) => [
      Number.parseInt(group.slice(0, 2), 16),
      Number.parseInt(group.slice(2), 16),
    ])
    .join('.');

/**
 * One client address in the form it is keyed by (ISSUE-257): an IPv6 zone
 * id is dropped, and an IPv6 address that embeds an IPv4 one is that IPv4
 * address. The ingress stamps this form (`client-ip.ts`), so no embedding
 * form reaches Better Auth's `getIP`, which would fold it into the all-zero
 * /64 every such client shares. Not an IP address: null.
 */
export function canonicalAddress(address: string): string | null {
  if (isIP(address) === 0) return null;
  const [base = ''] = address.split('%');
  if (isIP(base) !== 6) return base;
  const groups = ipv6Groups(base);
  return embedsIPv4(groups) ? embeddedIPv4(groups) : base;
}

const ipv4Network = (address: string): ClientNetwork => {
  const [a, b, c] = address.split('.');
  return { scope: 'ipv4_24', network: `${a}.${b}.${c}.0/24` };
};

/**
 * The networks a trusted client address belongs to, for the aggregate
 * magic-link buckets: an IPv6 client's /56 and /48, and an IPv4 client's
 * /24. The address is what Better Auth's `getIP` resolved from the header
 * the ingress stamps (`client-ip.ts`), so for IPv6 it is already the /64,
 * expanded; any IPv6 form is accepted. An address is keyed in its
 * `canonicalAddress` form, so an IPv6 address embedding an IPv4 one is in
 * that IPv4 /24 and a zone id is ignored. No client, an address in
 * `::/112` (the unspecified and loopback addresses among them), or a value
 * that is not an IP address, is in no network, so only the per-client
 * buckets apply.
 */
export function clientNetworks(
  client: string | null,
): readonly ClientNetwork[] {
  const address = client === null ? null : canonicalAddress(client);
  if (address === null) return [];
  if (isIP(address) === 4) return [ipv4Network(address)];
  const groups = ipv6Groups(address);
  // Every address left in ::/96 carries no client (AUTH-3.10.1): no network
  // rather than one shared bucket.
  if (zeros(groups.slice(0, 7))) return [];
  const [g0, g1, g2, g3 = '0000'] = groups;
  return [
    { scope: 'ipv6_56', network: `${g0}:${g1}:${g2}:${g3.slice(0, 2)}00::/56` },
    { scope: 'ipv6_48', network: `${g0}:${g1}:${g2}::/48` },
  ];
}

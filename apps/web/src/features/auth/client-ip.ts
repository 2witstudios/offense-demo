import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { canonicalAddress } from './client-networks';
import { deriveSubkey } from './recipient-key';

/** Internal header the ingress stamps; Better Auth reads only this one. */
export const CLIENT_IP_HEADER = 'x-offense-demo-client-ip';
/** Internal header the ingress stamps: the keyed hash request logs carry. */
export const CLIENT_ID_HASH_HEADER = 'x-offense-demo-client-id-hash';
/**
 * Fly's own authoritative single-value client address (AUTH-7.9): fly-proxy
 * sets it on every request it forwards, so once the peer is a trusted
 * fly-proxy hop it needs no chain-walking heuristic the way
 * `X-Forwarded-For` does
 * (https://fly.io/docs/networking/request-headers/).
 */
export const FLY_CLIENT_IP_HEADER = 'fly-client-ip';

export const deriveClientIdSubkey = (secret: string): string =>
  deriveSubkey(secret, 'client-id-hash');

/**
 * Correlates one client across log lines without the address. Keyed by a
 * subkey of the app secret, because a plain hash of an IPv4 address is
 * reversed by hashing all 2^32 of them.
 */
export const clientIdHash = (subkey: string, client: string): string =>
  createHash('sha3-256').update(`${subkey}\0${client}`).digest('hex');

/**
 * Only the dotted IPv4-mapped form is read as IPv4 for the trust decision:
 * any other spelling of a trusted hop (`::a.b.c.d`, `::ffff:0:a.b.c.d`, a
 * zone id) is not that hop (DEC-39). Only the resolved client is made
 * canonical, for its buckets (`resolveClientIp`, ISSUE-257).
 */
const unmap = (address: string) =>
  address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;

function blockList(entries: readonly string[]) {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

const isTrusted = (list: BlockList, address: string) => {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

/**
 * The right-most hop of `forwardedFor` that is not itself a trusted proxy,
 * so a caller-prepended left-most value never selects the rate-limit
 * identity; `peer` (already known trusted) is the fallback for an empty or
 * malformed chain.
 */
const resolveFromForwardedChain = (
  forwardedFor: string | null | undefined,
  trusted: BlockList,
  peer: string,
): string => {
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((hop) => unmap(hop.trim()))
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const hop = chain[index] ?? '';
    if (isIP(hop) === 0) return peer;
    if (!isTrusted(trusted, hop)) return hop;
  }
  return peer;
};

type ClientIpInput = {
  readonly peer: string | undefined;
  readonly forwardedFor: string | null | undefined;
  readonly flyClientIp?: string | null | undefined;
  readonly trustedProxies: readonly string[];
};

function resolveTrustedClient(input: ClientIpInput): string | null {
  if (!input.peer) return null;
  const peer = unmap(input.peer);
  if (isIP(peer) === 0) return null;
  if (input.trustedProxies.length === 0) return peer;
  const trusted = blockList(input.trustedProxies);
  if (!isTrusted(trusted, peer)) return peer;
  const flyClientIp = unmap((input.flyClientIp ?? '').trim());
  if (isIP(flyClientIp) !== 0) return flyClientIp;
  return resolveFromForwardedChain(input.forwardedFor, trusted, peer);
}

/**
 * The client is the socket peer unless the peer is a configured trusted
 * ingress hop (zero trust: a header is only ever read from a peer the
 * deployment names as its own proxy). A trusted peer's `Fly-Client-IP` is
 * taken directly, since fly-proxy sets it to the resolved caller address
 * itself, never a chain to walk; only when it is absent or unusable does
 * this fall back to walking `X-Forwarded-For` from the right. Trust is
 * decided on each address as it arrives; the client it resolves to is
 * returned in canonical form (no zone id, and an IPv4-embedding IPv6 form
 * as its IPv4 address), so no two clients share a bucket through their
 * notation (ISSUE-257).
 */
export function resolveClientIp(input: ClientIpInput): string | null {
  const client = resolveTrustedClient(input);
  return client === null ? null : (canonicalAddress(client) ?? client);
}

type IngressRequest = {
  readonly socket: { readonly remoteAddress?: string | undefined };
  readonly headers: Record<string, string | string[] | undefined>;
};

/**
 * Deployment ingress: replaces any caller-supplied identity and hash
 * headers with the resolved ones (or removes them) before the request
 * reaches application code.
 */
export function stampClientIdentity(
  request: IngressRequest,
  trustedProxies: readonly string[],
  clientIdSubkey: string,
): void {
  const forwarded = request.headers['x-forwarded-for'];
  const flyClientIpHeader = request.headers[FLY_CLIENT_IP_HEADER];
  const client = resolveClientIp({
    peer: request.socket.remoteAddress,
    forwardedFor: Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
    // Fly never duplicates this header; an array here is tampering, not a
    // value to salvage, so only a plain string is honored.
    flyClientIp:
      typeof flyClientIpHeader === 'string' ? flyClientIpHeader : undefined,
    trustedProxies,
  });
  if (client) {
    request.headers[CLIENT_IP_HEADER] = client;
    request.headers[CLIENT_ID_HASH_HEADER] = clientIdHash(
      clientIdSubkey,
      client,
    );
  } else {
    delete request.headers[CLIENT_IP_HEADER];
    delete request.headers[CLIENT_ID_HASH_HEADER];
  }
}

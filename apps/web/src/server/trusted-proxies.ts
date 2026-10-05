import { TRUSTED_PROXY_GATEWAY } from '@offense-demo/config';

const RTF_UP = 0x1;
const RTF_GATEWAY = 0x2;
const HEX_ADDRESS = /^[0-9A-Fa-f]{8}$/;

/** `/proc/net/route` holds IPv4 addresses as host-order (little-endian) hex. */
const decodeAddress = (hex: string) =>
  [6, 4, 2, 0]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    .join('.');

/**
 * This machine's single default IPv4 gateway from the text of
 * `/proc/net/route`, or null when there is none or more than one. On Fly the
 * gateway is the host end of the machine's private link, the one address
 * fly-proxy connects from (measured on staging, ISSUE-162); an ambiguous
 * table resolves nothing rather than guess which hop is the proxy.
 */
export function defaultGateway(routeTable: string): string | null {
  const gateways = new Set<string>();
  for (const line of routeTable.split('\n').slice(1)) {
    const [, destination, gateway, flags, , , , mask] = line
      .trim()
      .split(/\s+/);
    if (destination !== '00000000' || mask !== '00000000') continue;
    if (!gateway || !HEX_ADDRESS.test(gateway) || !flags) continue;
    const flagBits = Number.parseInt(flags, 16);
    if ((flagBits & RTF_UP) === 0 || (flagBits & RTF_GATEWAY) === 0) continue;
    gateways.add(decodeAddress(gateway));
  }
  return gateways.size === 1 ? [...gateways][0]! : null;
}

/**
 * Substitutes the resolved default gateway for the `gateway` keyword in the
 * validated `AUTH_TRUSTED_PROXIES` list. Fails closed: an unresolvable
 * gateway is trusted as nothing, and reported so startup can say so.
 */
export function resolveTrustedProxies(
  entries: readonly string[],
  gateway: string | null,
): { readonly trustedProxies: string[]; readonly gatewayUnresolved: boolean } {
  const wantsGateway = entries.includes(TRUSTED_PROXY_GATEWAY);
  const trustedProxies = entries.flatMap((entry) =>
    entry !== TRUSTED_PROXY_GATEWAY ? [entry] : gateway ? [gateway] : [],
  );
  return { trustedProxies, gatewayUnresolved: wantsGateway && !gateway };
}

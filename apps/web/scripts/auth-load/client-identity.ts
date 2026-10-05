/**
 * Simulated public client addresses, from the RFC 2544 benchmarking range
 * (198.18.0.0/15) the integration suites also use for fixture client
 * identities. Each of the harness's `clientCount` virtual clients gets one
 * fixed address for the whole run, sent as `X-Forwarded-For` through the
 * shared TLS edge; the app trusts it only because it arrives via the
 * loopback hop configured in `AUTH_TRUSTED_PROXIES` (`two-instances.ts`) —
 * never a header a real caller could set for itself.
 */
export function simulatedClients(clientCount: number): readonly string[] {
  const clients: string[] = [];
  for (let index = 1; index <= clientCount; index += 1)
    clients.push(
      `198.${18 + (index >> 16)}.${(index >> 8) & 255}.${index & 255}`,
    );
  return clients;
}

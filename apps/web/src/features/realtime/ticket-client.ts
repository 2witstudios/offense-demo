import { ticketSchema } from '@offense-demo/protocol';

/**
 * The RT-2.4a route's contract: `POST /api/realtime/ticket` issues a
 * single-use ticket in `@offense-demo/protocol`'s `ticketSchema` shape (ADR 0031
 * §11). Same-origin, credentials included so the session cookie
 * authenticates the caller. `fetchImpl` is injected: RT-2.4a is being built
 * in parallel, so tests stub the fetch against this contract rather than
 * hitting a real route.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchRealtimeTicket({
  fetchImpl,
}: {
  readonly fetchImpl: FetchLike;
}): Promise<string> {
  const response = await fetchImpl('/api/realtime/ticket', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`realtime ticket request failed: ${response.status}`);
  }
  const body: unknown = await response.json();
  const ticket =
    typeof body === 'object' && body !== null && 'ticket' in body
      ? Reflect.get(body, 'ticket')
      : undefined;
  const result = ticketSchema.safeParse(ticket);
  if (!result.success) {
    throw new Error('realtime ticket response was malformed');
  }
  return result.data;
}

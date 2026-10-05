import type { IncomingMessage } from 'node:http';
import { origin } from './fixtures';

/**
 * A socket request as the `Request` a route handler takes, the way Next
 * hands one over: every single-valued header and, for a POST, the body.
 */
export async function requestFrom(incoming: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers))
    if (typeof value === 'string') headers.set(name, value);
  return new Request(`${origin}${incoming.url}`, {
    method: incoming.method ?? 'POST',
    headers,
    ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
  });
}

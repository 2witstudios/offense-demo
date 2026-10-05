import { RedisClient } from 'bun';
import { resendRequest } from '../../src/features/auth/resend-capture.test-support';

/**
 * A private mail sink for a production-mode local server: the real Resend
 * sender runs unchanged, and only its outbound HTTP call is captured
 * (`captureFetch`, wired as `createApp`'s `fetch`) instead of reaching the
 * network. Captured mail is readable at `GET /mails?to=<address>` on the
 * returned loopback port; `POST /reset` clears the Redis namespace's
 * rate-limit keys, for a suite (or the AUTH-6.7 load harness) that needs a
 * clean limiter state between runs without touching the shared stack.
 */
export function createMailCapture({
  port,
  redisUrl,
  redisNamespace,
}: {
  readonly port: number;
  readonly redisUrl: string;
  readonly redisNamespace: string;
}) {
  type Captured = { to: string; subject: string; text: string };
  const mails: Captured[] = [];
  const captureFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const sent = resendRequest(input, init);
    if (!sent) return fetch(input, init);
    mails.push({
      to: sent.to.toLowerCase(),
      subject: sent.subject,
      text: sent.text,
    });
    return Response.json({ id: `msg_capture_${mails.length}` });
  };
  const resetRateLimits = async () => {
    const client = new RedisClient(redisUrl);
    try {
      const keys = (await client.send('KEYS', [
        `${redisNamespace}:*`,
      ])) as string[];
      for (const key of keys) await client.del(key);
    } finally {
      client.close();
    }
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/mails') {
        const to = (url.searchParams.get('to') ?? '').toLowerCase();
        return Response.json(mails.filter((mail) => mail.to === to));
      }
      if (url.pathname === '/reset' && request.method === 'POST') {
        await resetRateLimits();
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    captureFetch,
    mails,
    stop: (closeActiveConnections?: boolean) =>
      server.stop(closeActiveConnections),
  };
}

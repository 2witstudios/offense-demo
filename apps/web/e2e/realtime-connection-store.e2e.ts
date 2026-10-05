import { expect, test } from './support/fixtures';
import { resolveE2EPorts } from '../playwright.config';
import { buildRealtimeHarnessScript } from './support/realtime-harness';

/**
 * RT-2.6a's browser proof (revision 4.14): the real
 * `createBrowserConnectionStore` (bundled from source, not reimplemented)
 * driven in a real browser against the real `apps/realtime` scaffold booted
 * by this config's `webServer`. Ticket consumption is RT-2.4b, so every
 * `hello` here is rejected 4001 auth_failed today
 * (apps/realtime/src/handlers/hello.ts), and the store never reaches
 * `open` — this proves single-socket-per-tab and the close-code reactions
 * only. The heartbeat/visibility/throttling rules are proven deterministically
 * with an injected scheduler in the unit suite instead
 * (connection-store.test.ts, connection-store-heartbeat-throttle.test.ts);
 * the browser-level throttling proof is RT-2.7's. `POST /api/realtime/ticket`
 * (RT-2.4a) is a parallel, unmerged leaf, so `window.fetch`'s answer for it
 * is stubbed here — "stub the fetch in tests" applies to this browser suite
 * exactly as it does to the unit suite.
 */
const realtimePort = resolveE2EPorts(process.env).realtime;
const socketUrl = `ws://127.0.0.1:${realtimePort}/ws`;
// The production web app sets a strict `connect-src 'self'` CSP (proxy.ts),
// which correctly blocks a cross-origin WebSocket from that origin. Loading
// the harness from the realtime server's own origin instead (it sets no
// CSP) proves the store against the real scaffold without weakening the
// app's production security posture for this test.
const realtimeOrigin = `http://127.0.0.1:${realtimePort}`;

function stubTicketFetchAndCountingSocket() {
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/realtime/ticket')) {
      return Promise.resolve(
        new Response(JSON.stringify({ ticket: 'a'.repeat(43) }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return realFetch(input, init);
  }) as typeof window.fetch;

  const sockets: WebSocket[] = [];
  class CountingSocket extends WebSocket {
    constructor(target: string | URL) {
      super(target);
      sockets.push(this);
      (window as unknown as { __socketCount: number }).__socketCount =
        sockets.length;
    }
  }
  (window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    CountingSocket;
}

test('opens exactly one socket per tab even when many components mount, and the real 4001 close reaction reaches terminal signed-out after three tries', async ({
  page,
}) => {
  const harnessScript = buildRealtimeHarnessScript();
  await page.goto(realtimeOrigin + '/health/live');
  await page.addScriptTag({ content: harnessScript });
  await page.evaluate(stubTicketFetchAndCountingSocket);

  // The three connect() calls and the count read happen inside one
  // page.evaluate: createSocket runs synchronously inside connect(), so the
  // count is exactly 1 here, before any event (including the jittered
  // reconnect that follows the real 4001 close below) can run. Polling for
  // this count separately raced that reconnect: the whole test can finish
  // in under a second, so a poll's first read can already see socket 3.
  const socketCountAfterMount = await page.evaluate((url) => {
    const store = window.__offenseDemoRealtimeHarness(url);
    (window as unknown as { __rtStore: unknown }).__rtStore = store;

    // Many components mounting in one render: three concurrent connect()
    // calls before any socket has had a chance to open.
    store.connect();
    store.connect();
    store.connect();

    return (window as unknown as { __socketCount?: number }).__socketCount;
  }, socketUrl);
  expect(socketCountAfterMount).toBe(1);

  // The real scaffold rejects every hello with 4001 auth_failed today
  // (ticket consumption is RT-2.4b). The store's documented reaction is to
  // fetch a fresh ticket and reconnect, and to stop after 3 consecutive
  // failures with terminal signed-out (ADR 0031 §8). Waiting for that
  // terminal state, rather than asserting an exact socket count mid-flight,
  // is what makes this deterministic: the backoff between attempts is
  // jittered, so a poll for "count === 2" can race the third attempt.
  const getState = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          __rtStore: {
            getState(): { generation: number; terminal: string | null };
          };
        }
      ).__rtStore.getState(),
    );

  await expect
    .poll(async () => (await getState()).terminal, { timeout: 20_000 })
    .toBe('signed-out');

  const [state, socketCount] = await Promise.all([
    getState(),
    page.evaluate(
      () => (window as unknown as { __socketCount?: number }).__socketCount,
    ),
  ]);
  expect(state.generation).toBe(3);
  expect(socketCount).toBe(3);
});

test('negative control: a store never told to connect opens no socket against the real scaffold', async ({
  page,
}) => {
  const harnessScript = buildRealtimeHarnessScript();
  await page.goto(realtimeOrigin + '/health/live');
  await page.addScriptTag({ content: harnessScript });
  await page.evaluate(stubTicketFetchAndCountingSocket);

  const socketCount = await page.evaluate((url) => {
    window.__offenseDemoRealtimeHarness(url);
    // No connect() call.
    return (window as unknown as { __socketCount?: number }).__socketCount ?? 0;
  }, socketUrl);

  expect(socketCount).toBe(0);
});

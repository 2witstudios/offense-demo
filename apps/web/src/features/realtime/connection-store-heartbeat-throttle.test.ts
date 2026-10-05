import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { ENVELOPE_VERSION, heartbeatMs } from '@offense-demo/protocol';
import { createConnectionStore } from './connection-store';
import {
  FakeSocket,
  createTimerQueue,
  harness,
  openAndReady,
} from './connection-store.test-support';

setupRitewayBun();

/**
 * A scheduler where every `setTimeout` fires no earlier than the next
 * multiple of `throttleMs`, simulating Chromium's coalescing of a hidden
 * tab's chained timers to about once a minute (ADR 0031 §7). `now()` still
 * reports real elapsed time correctly whenever a callback actually runs.
 */
const createThrottledScheduler = (throttleMs: number) =>
  createTimerQueue(
    (clock, ms) => Math.ceil((clock + ms) / throttleMs) * throttleMs,
  );

/**
 * A fake server that answers every `ping` with a `pong` at once. Extends
 * the shared `FakeSocket` (connection-store.test-support.ts) rather than
 * reimplementing the open/close/message/emit scaffolding: only `send`'s
 * auto-pong behaviour is specific to this suite.
 */
class AlwaysPongSocket extends FakeSocket {
  override send(data: string) {
    const message: unknown = JSON.parse(data);
    if (
      typeof message === 'object' &&
      message !== null &&
      Reflect.get(message, 'type') === 'ping'
    ) {
      this.message({
        v: ENVELOPE_VERSION,
        type: 'pong',
        id: Reflect.get(message, 'id'),
      });
    }
  }
}

describe('heartbeat under a throttled hidden tab (ADR 0031 §7)', () => {
  test('a server that answers every ping never gets reaped, even when ticks fire ~60s late', async () => {
    const scheduler = createThrottledScheduler(60_000);
    let sock: AlwaysPongSocket | undefined;
    const store = createConnectionStore({
      url: 'wss://realtime.test/ws',
      createSocket: () => {
        sock = new AlwaysPongSocket();
        return sock;
      },
      scheduler,
      fetchTicket: async () => 'a'.repeat(43),
      random: () => 0.5,
      onVisibilityChange: () => () => {},
    });

    store.connect();
    sock!.open();
    await Promise.resolve();
    await Promise.resolve();
    sock!.message({ v: ENVELOPE_VERSION, type: 'ready' });

    scheduler.advance(10 * 60_000);

    assert({
      given:
        'a scheduler that coalesces every timer to once-a-minute boundaries (well past the 15s heartbeat period), and a server that answers every ping at once',
      should: 'never judge the healthy socket dead over 10 simulated minutes',
      actual: sock!.closedWith,
      expected: null,
    });
  });

  test('negative control: a server that never answers is still judged dead under the same throttled schedule', async () => {
    const scheduler = createThrottledScheduler(60_000);
    // A reconnect after death creates a second socket; capture the first
    // one specifically so a later reconnect can't hide a real reap.
    const sockets: AlwaysPongSocket[] = [];
    const store = createConnectionStore({
      url: 'wss://realtime.test/ws',
      createSocket: () => {
        const sock = new AlwaysPongSocket();
        sock.send = () => {}; // silent: never answers a ping.
        sockets.push(sock);
        return sock;
      },
      scheduler,
      fetchTicket: async () => 'a'.repeat(43),
      random: () => 0.5,
      onVisibilityChange: () => () => {},
    });
    const firstSocket = () => sockets[0]!;

    store.connect();
    firstSocket().open();
    await Promise.resolve();
    await Promise.resolve();
    firstSocket().message({ v: ENVELOPE_VERSION, type: 'ready' });

    scheduler.advance(10 * 60_000);

    assert({
      given: 'the same throttled schedule but a server that never answers',
      should:
        'still judge the first socket dead (proving the rule is exercised, not vacuous)',
      actual: firstSocket().closedWith !== null,
      expected: true,
    });
  });
});

describe('the earliest unanswered ping is never pushed back (RT-2.6a second-pass finding 1)', () => {
  test('repeated visibility changes never defer detecting a genuinely dead socket', async () => {
    const h = harness();
    await openAndReady(h); // ready at t=0: ping-1 sent, its deadline is 30s out.
    const deadSocket = h.latestSocket();

    // A user flipping tabs every 5s while the server never answers a ping
    // must not push the *first* ping's own deadline later.
    for (let i = 0; i < 5; i++) {
      h.scheduler.advance(5_000);
      h.fireVisible();
    }

    assert({
      given:
        '25s elapsed with a visibility ping fired every 5s, none ever answered',
      should:
        "not yet be judged dead: the earliest ping's own 30s deadline has not passed",
      actual: deadSocket.closedWith,
      expected: null,
    });

    h.scheduler.advance(5_000);

    assert({
      given: "the earliest ping's own deadline (30s after it was sent) reached",
      should: 'judge the socket dead despite the repeated visibility pings',
      actual: deadSocket.closedWith !== null,
      expected: true,
    });
  });
});

describe('a pong only answers the ping with its own id (ADR 0031 §7, third-pass minor)', () => {
  test("a stale duplicate pong for an earlier, already-answered ping never clears a newer ping's deadline", async () => {
    const h = harness();
    await openAndReady(h); // ready at t=0: ping-1 sent, tracked, deadline 30s out.
    const socket = h.latestSocket();

    h.scheduler.advance(heartbeatMs); // t=15s: still waiting on ping-1.
    socket.message({ v: ENVELOPE_VERSION, type: 'pong', id: 'ping-1' }); // answered on time.
    h.scheduler.advance(heartbeatMs); // t=30s: ping-1 was answered, so this tick sends ping-2.

    // A stale, out-of-order duplicate of ping-1's pong arrives after ping-2
    // is already the tracked ping. It must be ignored, not clear ping-2's
    // still-live deadline (ping-2's real deadline is t=60s).
    socket.message({ v: ENVELOPE_VERSION, type: 'pong', id: 'ping-1' });

    h.scheduler.advance(heartbeatMs); // t=45s: ping-2 not yet overdue.
    assert({
      given:
        'a stale duplicate pong for ping-1 arriving after ping-2 is tracked',
      should: "not clear ping-2's deadline: not yet dead at 45s",
      actual: socket.closedWith,
      expected: null,
    });

    h.scheduler.advance(heartbeatMs); // t=60s: ping-2's own deadline.
    assert({
      given: "ping-2's own deadline (30s after it was sent) reached",
      should:
        'judge the socket dead exactly there, proving the stale pong changed nothing',
      actual: socket.closedWith !== null,
      expected: true,
    });
  });
});

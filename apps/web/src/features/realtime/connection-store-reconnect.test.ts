import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { harness, flush, openAndReady } from './connection-store.test-support';

setupRitewayBun();

describe('connection store: close-code reactions and backoff (ADR 0031 §8)', () => {
  test('4001 auth_failed fetches a fresh ticket and reconnects with standard backoff', async () => {
    const h = harness();
    h.store.connect();
    h.latestSocket().open();
    await flush();
    const ticketCallsBeforeClose = h.ticketCalls.length;

    h.latestSocket().remoteClose(4001);
    h.scheduler.advance(30_000);
    await flush();

    assert({
      given: 'the server closing 4001 auth_failed',
      should: 'fetch another ticket and open a second socket after backing off',
      actual: {
        secondTicketFetched: h.ticketCalls.length > ticketCallsBeforeClose,
        socketCount: h.sockets.length,
      },
      expected: { secondTicketFetched: true, socketCount: 2 },
    });
  });

  test('three consecutive 4001s stop reconnecting (terminal signed-out)', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.store.connect();
      h.latestSocket().open();
      await flush();
      h.latestSocket().remoteClose(4001);
      h.scheduler.advance(60_000);
      await flush();
    }

    assert({
      given: '3 consecutive 4001 closes',
      should:
        'stop reconnecting and report signed-out, opening no further sockets',
      actual: { state: h.store.getState(), socketCount: h.sockets.length },
      expected: {
        state: { status: 'closed', generation: 3, terminal: 'signed-out' },
        socketCount: 3,
      },
    });
  });

  test('4002 revoked never reconnects', async () => {
    const h = harness();
    h.store.connect();
    h.latestSocket().open();
    await flush();

    h.latestSocket().remoteClose(4002);
    h.scheduler.advance(120_000);
    await flush();

    assert({
      given: 'the server closing 4002 revoked',
      should: 'stay closed with terminal revoked and open no new socket',
      actual: { state: h.store.getState(), socketCount: h.sockets.length },
      expected: {
        state: { status: 'closed', generation: 1, terminal: 'revoked' },
        socketCount: 1,
      },
    });
  });

  test('4004 rate_limited reconnects no sooner than the 30s floor', async () => {
    const h = harness();
    h.store.connect();
    h.latestSocket().open();
    await flush();

    h.latestSocket().remoteClose(4004);
    h.scheduler.advance(29_000);
    const socketsBeforeFloor = h.sockets.length;
    h.scheduler.advance(2_000);
    await flush();

    assert({
      given: 'the server closing 4004 rate_limited',
      should: 'not reconnect before the 30s floor, and reconnect once past it',
      actual: { socketsBeforeFloor, socketsAfterFloor: h.sockets.length },
      expected: { socketsBeforeFloor: 1, socketsAfterFloor: 2 },
    });
  });

  test('4006 server_restarting reconnects immediately within 0-5s', async () => {
    const h = harness();
    h.store.connect();
    h.latestSocket().open();
    await flush();

    h.latestSocket().remoteClose(4006);
    h.scheduler.advance(5_000);
    await flush();

    assert({
      given: 'the server closing 4006 server_restarting',
      should: 'reconnect within the 0-5s jitter window',
      actual: h.sockets.length,
      expected: 2,
    });
  });

  test('1006 abnormal closes reconnect with standard jittered backoff, no lifetime ceiling', async () => {
    const h = harness();
    h.store.connect();
    h.latestSocket().open();
    await flush();

    for (let i = 0; i < 5; i++) {
      h.latestSocket().remoteClose(1006);
      h.scheduler.advance(60_000);
      await flush();
    }

    assert({
      given: '5 consecutive abnormal (1006) closes',
      should: 'keep reconnecting every time (no lifetime ceiling)',
      actual: h.sockets.length,
      expected: 6,
    });
  });
});

describe('connection store: token refresh and logout', () => {
  test('token refresh never reconnects a healthy socket', async () => {
    const h = harness();
    await openAndReady(h);
    const before = {
      generation: h.store.getState().generation,
      socketCount: h.sockets.length,
    };

    h.store.notifyTokenRefreshed();

    assert({
      given: 'a healthy open socket',
      should:
        'leave the generation and socket count unchanged when the token refreshes',
      actual: {
        generation: h.store.getState().generation,
        socketCount: h.sockets.length,
      },
      expected: before,
    });
  });

  test('logout closes the socket and never reconnects', async () => {
    const h = harness();
    await openAndReady(h);

    h.store.close();
    h.scheduler.advance(120_000);
    await flush();

    assert({
      given: 'logout while a socket is open',
      should: 'close the socket and never open another',
      actual: {
        closedWith: h.latestSocket().closedWith,
        socketCount: h.sockets.length,
        status: h.store.getState().status,
      },
      expected: {
        closedWith: { code: 1000, reason: 'logout' },
        socketCount: 1,
        status: 'closed',
      },
    });
  });

  test('negative control: a remote close without calling close() does reconnect', async () => {
    // Proves the logout test above is exercising close(), not a store that
    // never reconnects at all.
    const h = harness();
    await openAndReady(h);

    h.latestSocket().remoteClose(1006);
    h.scheduler.advance(60_000);
    await flush();

    assert({
      given: 'a remote 1006 close with no logout call',
      should: 'reconnect',
      actual: h.sockets.length,
      expected: 2,
    });
  });
});

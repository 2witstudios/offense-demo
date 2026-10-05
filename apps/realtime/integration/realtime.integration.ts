import { assert, test, setupRitewayBun } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { ENVELOPE_VERSION, PROTOCOL_VERSION } from '@offense-demo/protocol';
import { SOCKET_PATH } from '../src/server';
import { bootServer } from './support';

setupRitewayBun();

requireTestServices(process.env);

/**
 * Opens a real WebSocket to a fresh server, sends `frame` as the first
 * message, and resolves with the close code and reason the server chose.
 */
const closeAfterFirstFrame = async (frame: string) => {
  const { origin, close } = await bootServer();
  const ws = new WebSocket(origin.replace('http', 'ws') + SOCKET_PATH);
  try {
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener('close', (event) =>
        resolve({ code: event.code, reason: event.reason }),
      );
    });
    ws.addEventListener('open', () => ws.send(frame));
    return await closed;
  } finally {
    await close();
  }
};

test('answers liveness and readiness against real PostgreSQL and Redis', async () => {
  const { origin, close } = await bootServer();
  try {
    const live = await fetch(`${origin}/health/live`);
    const ready = await fetch(`${origin}/health/ready`);

    assert({
      given: 'a real Bun.serve server with real Postgres, LISTEN and Redis',
      should: 'answer liveness and readiness, never exposing per-check detail',
      actual: {
        live: { status: live.status, body: await live.json() },
        ready: { status: ready.status, body: await ready.json() },
      },
      expected: {
        live: { status: 200, body: { status: 'alive' } },
        ready: { status: 200, body: { status: 'ready' } },
      },
    });
  } finally {
    await close();
  }
});

test('refuses a non-WebSocket request to the socket path with 400, never falling through', async () => {
  const { origin, close } = await bootServer();
  try {
    const response = await fetch(`${origin}${SOCKET_PATH}`);

    assert({
      given: 'a plain GET on the socket path',
      should: 'answer 400',
      actual: response.status,
      expected: 400,
    });
  } finally {
    await close();
  }
});

test('a real WebSocket client sending hello first is closed 4001 auth_failed', async () => {
  assert({
    given:
      'a well-formed hello over a real socket (ticket consumption is RT-2.4b)',
    should: 'close 4001 auth_failed',
    actual: await closeAfterFirstFrame(
      JSON.stringify({
        v: ENVELOPE_VERSION,
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        ticket: 'a'.repeat(43),
      }),
    ),
    expected: { code: 4001, reason: 'auth_failed' },
  });
});

test('a real WebSocket client sending an unparseable first frame is closed 4003 protocol_unsupported', async () => {
  assert({
    given: 'a first frame that is not JSON',
    should: 'close 4003 protocol_unsupported',
    actual: await closeAfterFirstFrame('not json'),
    expected: { code: 4003, reason: 'protocol_unsupported' },
  });
});

test('a real WebSocket client sending a well-formed message before hello is closed 4001, proving hello is not silently accepted', async () => {
  assert({
    given: 'a well-formed ping sent as the first message over a real socket',
    should:
      'close 4001 auth_failed, since every message before hello is rejected',
    actual: await closeAfterFirstFrame(
      JSON.stringify({ v: ENVELOPE_VERSION, type: 'ping', id: 'a'.repeat(24) }),
    ),
    expected: { code: 4001, reason: 'auth_failed' },
  });
});

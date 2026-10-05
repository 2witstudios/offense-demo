import { ENVELOPE_VERSION } from '@offense-demo/protocol';
import { createConnectionStore, type WebSocketLike } from './connection-store';
import type { Scheduler } from './heartbeat';

export const validTicket = 'a'.repeat(43);

/**
 * A controllable virtual clock and timer queue: no real timers in tests.
 * `computeAt` maps a `setTimeout` call's (current clock, requested delay) to
 * the absolute time it actually fires, so this same queue backs both a
 * plain fake scheduler (fires exactly on request) and a throttled one
 * (connection-store-heartbeat-throttle.test.ts's hidden-tab simulation,
 * which coalesces every fire to a later boundary) without duplicating the
 * timer-map/advance scaffolding between them.
 */
export function createTimerQueue(
  computeAt: (clock: number, ms: number) => number,
): Scheduler & { advance(ms: number): void } {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => clock,
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { at: computeAt(clock, ms), cb });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const target = clock + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        timers.delete(id);
        clock = t.at;
        t.cb();
      }
      clock = target;
    },
  };
}

const createFakeScheduler = () => createTimerQueue((clock, ms) => clock + ms);

export type Listener = (event: {
  type: string;
  [key: string]: unknown;
}) => void;

/**
 * A fake native WebSocket: no network, fully driven by the test. Exported so
 * other realtime test files (e.g. the throttled-heartbeat suite) subclass it
 * for their own fake server behaviour instead of reimplementing the
 * open/close/message/emit scaffolding.
 */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    if (this.closedWith) return;
    const resolvedCode = code ?? 1000;
    const resolvedReason = reason ?? '';
    this.closedWith = { code: resolvedCode, reason: resolvedReason };
    this.readyState = 3;
    this.emit('close', {
      type: 'close',
      code: resolvedCode,
      reason: resolvedReason,
    });
  }
  open() {
    this.readyState = 1;
    this.emit('open', { type: 'open' });
  }
  message(data: unknown) {
    this.emit('message', { type: 'message', data: JSON.stringify(data) });
  }
  remoteClose(code: number) {
    if (this.closedWith) return;
    this.closedWith = { code };
    this.readyState = 3;
    this.emit('close', { type: 'close', code, reason: '' });
  }
  protected emit(
    type: string,
    event: { type: string; [key: string]: unknown },
  ) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

export function harness() {
  const sockets: FakeSocket[] = [];
  const scheduler = createFakeScheduler();
  const ticketCalls: number[] = [];
  let visibilityHandler: ((visible: boolean) => void) | null = null;
  const store = createConnectionStore({
    url: 'wss://realtime.test/ws',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    fetchTicket: async () => {
      ticketCalls.push(scheduler.now());
      return validTicket;
    },
    random: () => 0.5,
    onVisibilityChange: (cb) => {
      visibilityHandler = cb;
      return () => {
        visibilityHandler = null;
      };
    },
  });
  return {
    store,
    scheduler,
    sockets,
    ticketCalls,
    latestSocket: () => sockets[sockets.length - 1]!,
    fireVisible: () => visibilityHandler?.(true),
  };
}

export async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

export async function openAndReady(h: ReturnType<typeof harness>) {
  h.store.connect();
  h.latestSocket().open();
  await flush();
  h.latestSocket().message({ v: ENVELOPE_VERSION, type: 'ready' });
}

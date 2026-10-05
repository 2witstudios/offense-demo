import { ENVELOPE_VERSION, heartbeatMs } from '@offense-demo/protocol';

/**
 * The injected timing seam: production wires real `performance.now`/
 * `setTimeout`/`clearTimeout`; tests wire a virtual clock and timer queue so
 * the heartbeat and backoff rules are proven deterministically (AGENTS.md:
 * inject clocks, never sleep-and-hope).
 */
export type Scheduler = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (id: unknown) => void;
};

const HEARTBEAT_DEAD_AFTER_MS = heartbeatMs * 2;

/**
 * The connection's view the heartbeat needs, by socket generation: whether
 * a generation is still the current one, whether it also still has a
 * socket to send on, how to send a frame on it, and what to do when its
 * earliest unanswered ping is overdue.
 */
type HeartbeatDeps = {
  readonly scheduler: Scheduler;
  readonly isCurrent: (generation: number) => boolean;
  readonly canSend: (generation: number) => boolean;
  readonly send: (data: string) => void;
  readonly onDead: (generation: number) => void;
};

type Heartbeat = {
  /** On `ready`: ping at once, then every heartbeatMs. */
  readonly start: (generation: number) => void;
  /** Stops ticking and forgets any outstanding ping. */
  readonly stop: () => void;
  /** The visibilitychange nudge (ADR 0031 §7). */
  readonly nudge: (generation: number) => void;
  /** A `pong` frame's id arrived. */
  readonly answer: (id: unknown) => void;
};

/** The client heartbeat of the realtime connection store (ADR 0031 §7). */
export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  /**
   * The id and deadline of the *earliest* outstanding (unanswered) ping, or
   * null when it has already been answered (or none has been sent yet).
   * Judging death by this — the age of the oldest unanswered ping — rather
   * than by elapsed time since the tick last happened to run is what keeps a
   * throttled hidden tab from declaring a healthy socket dead: a ping that
   * gets answered promptly clears this before the next (possibly late) tick
   * ever checks it, so a late tick just sends a fresh ping and waits.
   *
   * Only a `pong` whose `id` matches this one clears it (ADR 0031 §7: "the
   * client sends ping every 15s and expects pong" with the same id), and
   * nothing may push the deadline later once it is set: an extra ping (the
   * visibilitychange nudge) is still sent on the wire, but never starts or
   * extends tracking while an earlier ping is still outstanding — otherwise
   * repeated visibility changes could defer detecting a truly dead socket
   * forever.
   */
  let outstandingPingId: string | null = null;
  let outstandingPingDeadline: number | null = null;
  let pingCounter = 0;
  let heartbeatTimer: unknown = null;

  const pingFrame = (id: string) =>
    JSON.stringify({ v: ENVELOPE_VERSION, type: 'ping', id });
  function clearHeartbeat() {
    if (heartbeatTimer !== null) deps.scheduler.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  /** Sends a ping frame and returns its id, or undefined if nothing was sent. */
  function sendPingFrame(myGeneration: number): string | undefined {
    if (!deps.canSend(myGeneration)) return undefined;
    pingCounter += 1;
    const id = `ping-${pingCounter}`;
    deps.send(pingFrame(id));
    return id;
  }
  /** Starts tracking `id` as the earliest outstanding ping's own deadline. */
  function trackOutstandingPing(id: string) {
    outstandingPingId = id;
    outstandingPingDeadline = deps.scheduler.now() + HEARTBEAT_DEAD_AFTER_MS;
  }
  /**
   * Sends a fresh ping known to be the only one in flight (on `ready`, or a
   * tick that found nothing outstanding) and starts tracking its deadline.
   * Tracking is set before the socket send so that a synchronously-delivered
   * pong (real sockets never are, but a test double may be) still clears it
   * rather than being overwritten afterward — this requires knowing the id
   * in advance, so `pingCounter` is read here rather than inside `sendPingFrame`.
   */
  function sendFreshPing(myGeneration: number) {
    pingCounter += 1;
    const id = `ping-${pingCounter}`;
    trackOutstandingPing(id);
    if (!deps.canSend(myGeneration)) return;
    deps.send(pingFrame(id));
  }
  function scheduleHeartbeatTick(myGeneration: number) {
    heartbeatTimer = deps.scheduler.setTimeout(() => {
      if (!deps.isCurrent(myGeneration)) return;
      if (
        outstandingPingDeadline !== null &&
        deps.scheduler.now() >= outstandingPingDeadline
      ) {
        // The ping that is overdue was actually sent (and given its own
        // deadline) at send time, so this fires only when the server truly
        // failed to answer it within HEARTBEAT_DEAD_AFTER_MS of *that* send
        // — never merely because this tick itself ran late.
        deps.onDead(myGeneration);
        return;
      }
      if (outstandingPingDeadline === null) {
        // The previous ping (if any) was already answered: send a fresh one
        // and start tracking its own deadline. A tick that finds a ping
        // still outstanding but not yet overdue sends nothing and waits.
        sendFreshPing(myGeneration);
      }
      scheduleHeartbeatTick(myGeneration);
    }, heartbeatMs);
  }

  return {
    start(myGeneration) {
      clearHeartbeat();
      sendFreshPing(myGeneration);
      scheduleHeartbeatTick(myGeneration);
    },
    stop() {
      clearHeartbeat();
      outstandingPingId = null;
      outstandingPingDeadline = null;
    },
    /**
     * Always sent on the wire, but it only starts tracking a deadline when
     * nothing is currently outstanding. If an earlier ping is still
     * awaiting its answer, this must never push that ping's own deadline
     * later — repeated visibility changes could otherwise defer detecting a
     * truly dead socket forever.
     */
    nudge(myGeneration) {
      const id = sendPingFrame(myGeneration);
      if (id !== undefined && outstandingPingId === null)
        trackOutstandingPing(id);
    },
    /**
     * Only a pong matching the earliest outstanding ping's own id clears it
     * (ADR 0031 §7): a late pong for an older, already-superseded ping must
     * never cancel a newer ping's still-live deadline.
     */
    answer(id) {
      if (id !== outstandingPingId) return;
      outstandingPingId = null;
      outstandingPingDeadline = null;
    },
  };
}

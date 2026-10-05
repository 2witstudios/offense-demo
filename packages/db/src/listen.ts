import type { SQL } from 'bun';

/** Proves LISTEN works without holding a subscription open (ADR 0031 readiness). */
export async function probeListen(client: SQL): Promise<void> {
  const subscription = await client.listen(
    'offense_demo_realtime_readiness_probe',
    () => {},
  );
  await subscription.unlisten();
}

export type OutboxListenHandlers = {
  /** Fires on every `pg_notify('outbox', position)`; the position is a hint only. */
  readonly onNotify: (position: string) => void;
  /**
   * Fires once the initial `LISTEN` is acknowledged and again after every
   * reconnect (Bun SQL's exponential backoff, ADR 0032 §3): the place a
   * drain loop catches up from its in-memory cursor, since notifications
   * sent while the connection was down are lost.
   */
  readonly onListen: () => void;
};

/**
 * Subscribes to the `outbox` channel on the client's dedicated LISTEN
 * connection (ADR 0032 §3). The returned promise resolves once PostgreSQL
 * has acknowledged the `LISTEN`, satisfying startup order step 1 (ADR 0032
 * §2): a notification issued after this resolves is guaranteed delivered.
 */
export async function subscribeOutbox(
  client: SQL,
  handlers: OutboxListenHandlers,
): Promise<{ readonly unlisten: () => Promise<void> }> {
  const subscription = await client.listen(
    'outbox',
    (position: string) => handlers.onNotify(position),
    () => handlers.onListen(),
  );
  return { unlisten: () => subscription.unlisten() };
}

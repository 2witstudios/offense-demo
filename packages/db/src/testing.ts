import type { SQL } from 'bun';

const POLL_INTERVAL_MS = 10;

/** Every other backend in the cluster that holds an xid, oldest first. */
const describeXidHolders = async (client: SQL): Promise<string> => {
  const holders = (await client.unsafe(`
    select datname, pid, application_name, state,
      (extract(epoch from now() - xact_start) * 1000)::int as "openMs"
    from pg_stat_activity
    where backend_xid is not null and pid <> pg_backend_pid()
    order by xact_start
  `)) as Array<{
    datname: string | null;
    pid: number;
    application_name: string;
    state: string | null;
    openMs: number | null;
  }>;
  if (holders.length === 0) return 'no xid-holding transaction is open now';
  return holders
    .map(
      (holder) =>
        `database "${holder.datname ?? '?'}" pid ${holder.pid} (${holder.application_name || 'no application_name'}, ${holder.state ?? 'unknown state'}, open ${holder.openMs ?? '?'} ms)`,
    )
    .join('; ');
};

/**
 * Test support for suites that assert on `drainOutbox` or the drain loop
 * (ISSUE-82): resolves once the outbox position written by transaction
 * `txid` is final, i.e. below `pg_snapshot_xmin(pg_current_snapshot())`,
 * the exact condition the drain reads by (ADR 0032 §1). That xmin is
 * cluster-wide, so on a shared PostgreSQL any older xid-holding transaction
 * in any database holds the row back until it ends; a test that drains the
 * moment its own commit returns sees nothing. Waiting on the condition, not
 * a fixed delay, costs only as long as those older transactions run: xids
 * only increase, so transactions that start later never hold it back.
 * There is no server-side wakeup for xmin advancing, so this polls the
 * condition itself. Past `deadlineMs` it rejects naming every xid holder in
 * the cluster, so a stuck foreign transaction is reported, not a timeout.
 * The caller injects the clock (`now`, in milliseconds).
 */
export async function waitForOutboxFinality(
  client: SQL,
  txid: string,
  {
    now,
    deadlineMs = 3000,
  }: { readonly now: () => number; readonly deadlineMs?: number },
): Promise<void> {
  const deadline = now() + deadlineMs;
  for (;;) {
    const [row] = (await client.unsafe(
      'select pg_snapshot_xmin(pg_current_snapshot()) > $1::xid8 as final',
      [txid],
    )) as Array<{ final: boolean }>;
    if (row?.final) return;
    if (now() >= deadline)
      throw new Error(
        `Outbox txid ${txid} is still not final after ${deadlineMs} ms; xid holders: ${await describeXidHolders(client)}`,
      );
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Test support for suites that pin a lock interleaving (ISSUE-22,
 * ISSUE-103): which comes first for `work`, finishing, or the database
 * reporting a backend blocked on a lock `holderPid` holds
 * (`pg_blocking_pids`, not a timer). Past `deadlineMs` it rejects, so work
 * that neither finishes nor blocks fails loudly instead of hanging the
 * suite. The caller injects the clock (`now`, in milliseconds).
 */
export async function finishedOrBlockedBehind(
  work: Promise<unknown>,
  observer: SQL,
  holderPid: number,
  {
    now,
    deadlineMs = 5000,
  }: { readonly now: () => number; readonly deadlineMs?: number },
): Promise<'finished' | 'blocked'> {
  let finished = false;
  void work.then(
    () => (finished = true),
    () => (finished = true),
  );
  const deadline = now() + deadlineMs;
  for (;;) {
    if (finished) return 'finished';
    const [row] = (await observer.unsafe(
      'select count(*)::int as waiting from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [holderPid],
    )) as Array<{ waiting: number }>;
    if ((row?.waiting ?? 0) > 0) return 'blocked';
    if (now() >= deadline)
      throw new Error(
        `Work neither finished nor blocked behind pid ${holderPid} within ${deadlineMs} ms`,
      );
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

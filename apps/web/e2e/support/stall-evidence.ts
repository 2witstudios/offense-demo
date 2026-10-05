/**
 * The verdict on a page creation that never finished (ISSUE-279): which
 * layer stopped, from the evidence the shared fixture keeps for the window.
 *
 *   - browser: Playwright sent the page-creation command and the browser
 *     never answered it, never attached the new page, or never answered a
 *     command to the new page's own session;
 *   - driver: Playwright's own event loop was starved, so an answer could not
 *     be read, or every command was answered and newPage still did not
 *     resolve, or the command was never sent;
 *   - server: not a cause of a page creation (no page exists yet to reach
 *     it), but its event loop and requests in the window are reported so a
 *     starved host shows on every side.
 *
 * Pure: the fixture collects the inputs and writes the result.
 */

/**
 * One protocol message, reduced to what tells the layers apart: its
 * direction, id, method and session, and the session a target-attach event
 * opens. Parameters and results are otherwise never kept, so no cookie,
 * header or credential reaches the evidence.
 */
export type ProtocolEntry = {
  readonly at: number;
  readonly direction: 'send' | 'recv';
  readonly id?: number | undefined;
  readonly method?: string | undefined;
  readonly error?: string | undefined;
  /** The protocol session a command went to; none is the browser's own. */
  readonly session?: string | undefined;
  /** The session a target-attach event opens, for the new page's own. */
  readonly opens?: string | undefined;
  /**
   * The target a create response returned or an attach event is for, so the
   * new page's attach is told apart from another target's.
   */
  readonly target?: string | undefined;
};

type Layer = 'browser' | 'driver';
export type Verdict = { readonly layer: Layer; readonly detail: string };

/** A driver event-loop delay this long means it could not read an answer. */
const STARVED_MS = 1_000;

/** Each engine's page-creation command. */
const createMethods = new Set([
  'Target.createTarget',
  'Playwright.createPage',
  'Browser.newPage',
]);

const since = (at: number, from: number) => `+${Math.round(at - from)}ms`;
const sessionName = ({ session }: ProtocolEntry) =>
  session ? `session ${session}` : 'the browser session';

/** The protocol's verdict for the window that started at `from`. */
export function protocolVerdict(
  entries: readonly ProtocolEntry[],
  from: number,
): Verdict {
  const window = entries.filter(({ at }) => at >= from);
  const answeredIds = new Set(
    window.flatMap(({ direction, id }) =>
      direction === 'recv' && id !== undefined ? [id] : [],
    ),
  );
  const create = window.find(
    ({ direction, method }) =>
      direction === 'send' && method !== undefined && createMethods.has(method),
  );
  if (!create)
    return {
      layer: 'driver',
      detail: 'Playwright sent no page-creation command in the window',
    };
  const heardAfter = (at: number) =>
    window.filter((entry) => entry.direction === 'recv' && entry.at > at)
      .length;
  if (!answeredIds.has(create.id!))
    return {
      layer: 'browser',
      detail: `the browser never answered ${create.method} #${create.id} (sent ${since(create.at, from)}) and sent ${heardAfter(create.at)} other message(s) after it`,
    };
  // The new page's own session is the one its attach event opens: the
  // browser-level attach for the target the create returned (ISSUE-287), or,
  // when the response names no target, the first one after the create. Only
  // its commands are the new page's, so another page's call still in flight
  // never counts against the browser (ISSUE-284).
  const created = window.find(
    ({ direction, id }) => direction === 'recv' && id === create.id,
  )?.target;
  const attach = window.find(
    ({ direction, opens, session, at, target }) =>
      direction === 'recv' &&
      opens !== undefined &&
      session === undefined &&
      (created === undefined ? at >= create.at : target === created),
  );
  if (!attach)
    return {
      layer: 'browser',
      detail: `the browser answered ${create.method} #${create.id} but never attached the new page (${
        created === undefined
          ? 'no target-attach event after it'
          : `no target-attach event for target ${created}`
      })`,
    };
  const page = `session ${attach.opens}`;
  const pending = window.filter(
    ({ direction, id, at, session }) =>
      direction === 'send' &&
      at >= create.at &&
      session === attach.opens &&
      !answeredIds.has(id!),
  );
  const [first] = pending;
  if (first) {
    // Answers to commands sent after the first unanswered one, on any
    // session, show whether the browser process itself was still running.
    const later = window.filter(
      ({ direction, id, at }) =>
        direction === 'send' &&
        at >= first.at &&
        id !== first.id &&
        answeredIds.has(id!),
    );
    const named = later
      .slice(0, 3)
      .map((entry) => `${entry.method} #${entry.id} on ${sessionName(entry)}`)
      .join(', ');
    return {
      layer: 'browser',
      detail: `the browser answered ${create.method} #${create.id} but never answered ${pending.length} command(s) to the new page (${page}), first ${first.method} #${first.id} (sent ${since(first.at, from)}); ${
        later.length
          ? `meanwhile it answered ${later.length} command(s) sent after that (${named}), so the browser process was running while the page did not answer`
          : `it answered nothing sent after that, and sent ${heardAfter(first.at)} other message(s)`
      }`,
    };
  }
  return {
    layer: 'driver',
    detail: `the browser answered every command to the new page (${page}), ${create.method} #${create.id} included, yet newPage never resolved`,
  };
}

export type ServerWindow = {
  readonly requests: number;
  readonly loopSamples: number;
  readonly loopMaxDelayMs: number;
  readonly loopSilentMs: number;
  readonly lines: readonly string[];
};

/**
 * The server log's lines in [from, to] (epoch ms): requests completed, and
 * the e2e server's once-a-second event-loop samples. `loopSilentMs` is the
 * longest stretch of the window with no sample: a starved or stopped server
 * writes none.
 */
export function serverWindow(
  log: string,
  from: number,
  to: number,
): ServerWindow {
  const records = log.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line) as {
        time?: number;
        event?: string;
        maxDelayMs?: number;
      };
      return typeof record.time === 'number' &&
        record.time >= from &&
        record.time <= to
        ? [{ line, ...record, time: record.time }]
        : [];
    } catch {
      return [];
    }
  });
  const samples = records.filter(({ event }) => event === 'e2e.event_loop');
  const times = [from, ...samples.map(({ time }) => time), to];
  return {
    requests: records.filter(({ event }) => event === 'http.request.completed')
      .length,
    loopSamples: samples.length,
    loopMaxDelayMs: Math.max(0, ...samples.map((s) => s.maxDelayMs ?? 0)),
    loopSilentMs: Math.max(
      ...times.slice(1).map((time, index) => time - times[index]!),
    ),
    lines: records.map(({ line }) => line),
  };
}

/** The layer that stopped, weighing the driver's own starvation first. */
export function judgeStall({
  protocol,
  driverMaxDelayMs,
  server,
}: {
  readonly protocol: Verdict;
  readonly driverMaxDelayMs: number;
  readonly server: ServerWindow;
}): Verdict {
  // A starved driver cannot read the browser's answer, so an unanswered
  // command in its log proves nothing about the browser.
  if (driverMaxDelayMs >= STARVED_MS)
    return {
      layer: 'driver',
      detail: `the driver's event loop stalled ${Math.round(driverMaxDelayMs)} ms, so the protocol log cannot show whether the browser answered`,
    };
  const serverNote =
    server.loopSilentMs >= STARVED_MS * 2
      ? `; our server's event loop was also silent for ${server.loopSilentMs} ms (host-wide starvation?)`
      : '';
  return { ...protocol, detail: `${protocol.detail}${serverNote}` };
}

/**
 * One `ps` row as evidence: the executable's name only, never its directory
 * or anything a process wrote into its title after it.
 */
export const psRow = (
  pid: string,
  stat: string,
  cpu: string,
  comm: readonly string[],
) => `${pid} ${stat} ${cpu}% ${comm.join(' ').split('/').pop()}`;

/**
 * The worker's process tree from `ps -Ao pid=,ppid=,stat=,pcpu=,comm=`
 * output: the browser and its helpers, with each one's scheduler state
 * (R running, S sleeping, T stopped, U uninterruptible) and CPU share.
 */
export function processTree(ps: string, root: number): string[] {
  const rows = ps
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/))
    .map(([pid, ppid, stat, cpu, ...comm]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      text: psRow(pid!, stat!, cpu!, comm),
    }));
  const lines: string[] = [];
  const walk = (pid: number, depth: number) => {
    for (const row of rows.filter(({ ppid }) => ppid === pid)) {
      lines.push(`${'  '.repeat(depth)}${row.text}`);
      walk(row.pid, depth + 1);
    }
  };
  walk(root, 0);
  return lines;
}

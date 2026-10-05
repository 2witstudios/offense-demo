import type { TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { cpus, freemem, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';
import utilsBundle from 'playwright-core/lib/utilsBundle';
import { resolveE2EPorts } from '../../playwright.config';
import {
  judgeStall,
  processTree,
  psRow,
  protocolVerdict,
  serverWindow,
  type ProtocolEntry,
} from './stall-evidence';

/**
 * Collects what a stalled page creation leaves behind (ISSUE-279), so the
 * next stall says whether the browser, the driver or our server stopped:
 * Playwright's protocol traffic for the test, the driver's event-loop
 * delay, the server log's requests and event-loop samples, and the host's
 * load and the worker's process states. The verdict itself is pure
 * (stall-evidence.ts).
 */
const RING = 4_000;
const entries: ProtocolEntry[] = [];
const markers = ['SEND ► ', '◀ RECV '] as const;
const attachEvents = new Set([
  'Target.attachedToTarget',
  'Browser.attachedToTarget',
  'Playwright.pageProxyCreated',
]);
/** Shortens an opaque protocol handle so the evidence stays readable. */
const handle = (value: string | undefined) =>
  value === undefined ? undefined : String(value).slice(0, 8);

type Message = {
  id?: number;
  method?: string;
  error?: { message?: string };
  sessionId?: string;
  pageProxyId?: string;
  params?: {
    sessionId?: string;
    pageProxyId?: string;
    targetInfo?: { targetId?: string };
  };
  result?: { targetId?: string; pageProxyId?: string };
};

/**
 * The target a create response returned (Chromium's and Firefox's targetId,
 * WebKit's pageProxyId) or an attach event is for, so the verdict keys the
 * new page to its own attach (ISSUE-287). An opaque handle, like a session.
 */
const targetOf = ({ method, params, result }: Message) =>
  attachEvents.has(method ?? '')
    ? handle(params?.targetInfo?.targetId ?? params?.pageProxyId)
    : handle(result?.targetId ?? result?.pageProxyId);

/** A parsed message's id, method, error text, sessions and target. */
const reduce = (message: Message) => {
  const { id, method, error, sessionId, pageProxyId, params } = message;
  return {
    id,
    method,
    error: error?.message?.slice(0, 200),
    // Chromium and Firefox address a page by sessionId, WebKit by pageProxyId.
    session: handle(sessionId ?? pageProxyId),
    // The session a new target's attach event opens, so the verdict judges
    // only the new page's own commands (ISSUE-284).
    opens: attachEvents.has(method ?? '')
      ? handle(params?.sessionId ?? params?.pageProxyId)
      : undefined,
    target: targetOf(message),
  };
};

/** Reduces one pw:protocol line to its direction, id, method, sessions and target. */
const entryOf = (text: string): ProtocolEntry | undefined => {
  const marker = markers.find((candidate) => text.includes(candidate));
  if (!marker) return undefined;
  const at = performance.now();
  const direction = marker === markers[0] ? 'send' : 'recv';
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return { at, direction, ...reduce(JSON.parse(body) as Message) };
  } catch {
    return { at, direction };
  }
};

/**
 * Records Playwright's protocol log (pw:protocol) for the running test into
 * a bounded ring, keeping only each message's direction, id, method,
 * sessions and target, and returns the function that stops recording.
 * Other DEBUG namespaces keep reaching the original log.
 */
export function recordProtocol(): () => void {
  const { debug } = utilsBundle;
  entries.length = 0;
  const userWanted = debug.enabled('pw:protocol');
  const previous = debug.disable();
  const log = debug.log;
  debug.log = (...args: unknown[]) => {
    const entry = entryOf(String(args[0]));
    if (!entry || userWanted) log(...args);
    if (!entry) return;
    entries.push(entry);
    if (entries.length > RING * 2) entries.splice(0, RING);
  };
  debug.enable(previous ? `${previous},pw:protocol` : 'pw:protocol');
  return () => {
    debug.disable();
    debug.log = log;
    if (previous) debug.enable(previous);
  };
}

const line = (entry: ProtocolEntry, from: number) =>
  `+${Math.round(entry.at - from)}ms ${entry.direction === 'send' ? 'SEND ►' : '◀ RECV'} ${
    entry.id === undefined ? 'event' : `#${entry.id}`
  }${entry.method ? ` ${entry.method}` : ''}${entry.session ? ` [${entry.session}]` : ''}${entry.opens ? ` opens [${entry.opens}]` : ''}${entry.target ? ` target [${entry.target}]` : ''}${entry.error ? ` error: ${entry.error}` : ''}`;

/** The whole test's protocol tail, for a failed test's protocol.log. */
export const protocolLog = () =>
  entries.map((entry) => line(entry, entries[0]?.at ?? 0)).join('\n');

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

/** Marks the start of a page creation the evidence will describe. */
export function startWindow() {
  loop.reset();
  return performance.now();
}

/**
 * The whole evidence capture's budget, well inside the test's 30 s after a
 * 15 s bound: the first captured stall spent its remaining 15 s on ps and
 * the server log at load 222 and surfaced as a bare "Test timeout", not the
 * named failure (ISSUE-282). Reading gets most of it; writing the rest.
 */
export const CAPTURE_BUDGET_MS = 3_000;
const READ_BUDGET_MS = 2_000;

/** `work`'s result, or a line saying it did not finish within `ms`. */
const within = async (what: string, work: Promise<string>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`${what} did not finish within ${ms} ms`),
      ms,
    );
  });
  try {
    return await Promise.race([
      work.catch((error: Error) => `${what} failed: ${error.message}`),
      cut,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const ps = async () => {
  try {
    const { stdout } = await promisify(execFile)(
      'ps',
      ['-Ao', 'pid=,ppid=,stat=,pcpu=,comm='],
      { timeout: READ_BUDGET_MS },
    );
    return stdout;
  } catch (error) {
    // The first captured stall lost this to a bare "Command failed" at load
    // 222: keep how it failed (exit code, signal, timeout kill, stderr).
    const { code, signal, killed, stderr } = error as {
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      stderr?: unknown;
    };
    return `ps failed: code ${String(code)}, signal ${String(signal)}, killed ${String(killed)}: ${String(
      stderr ?? '',
    )
      .trim()
      .slice(0, 200)}`;
  }
};

/**
 * The last 256 KiB of the server log: the window is the last few seconds,
 * and the whole log of a long run is megabytes to read and parse.
 */
const tail = async (path: string) => {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
};

/**
 * Writes stall-evidence.log for a page creation that started at `from` and
 * outlived its limit, and returns the layer the evidence names, all within
 * CAPTURE_BUDGET_MS. The verdict and the protocol are cut at the moment the
 * bound fired; the process snapshot and the server log are what arrives
 * within the read budget.
 */
export async function recordStall(
  testInfo: TestInfo,
  { step, from, limitMs }: { step: string; from: number; limitMs: number },
  processSnapshot: () => Promise<string> = ps,
): Promise<string> {
  const to = performance.now();
  const window = entries.filter(({ at }) => at >= from && at <= to);
  // The bound's own timer firing late is the driver's delay too: a starved
  // loop runs it late (and may not have sampled the histogram yet).
  const lateMs = to - from - limitMs;
  const loopMaxMs = loop.max / 1e6;
  const loopMeanMs = loop.mean / 1e6;
  const epoch = (at: number) => performance.timeOrigin + at;
  const serverLogPath = join(
    dirname(testInfo.config.configFile ?? '.'),
    'test-results',
    `server-${resolveE2EPorts(process.env).app}.log`,
  );
  const [serverLog, processes] = await Promise.all([
    within('the server log read', tail(serverLogPath), READ_BUDGET_MS),
    within('the process snapshot', processSnapshot(), READ_BUDGET_MS),
  ]);
  const server = serverWindow(serverLog, epoch(from), epoch(to));
  const verdict = judgeStall({
    protocol: protocolVerdict(window, from),
    driverMaxDelayMs: Math.max(loopMaxMs, lateMs),
    server,
  });
  // ps rows start with a pid and a ppid; anything else is why there are none.
  const listed = /^\s*\d+\s+\d+\s/.test(processes);
  const top = listed
    ? processes
        .trim()
        .split('\n')
        .map((row) => row.trim().split(/\s+/))
        .sort((a, b) => Number(b[3]) - Number(a[3]))
        .slice(0, 10)
        .map(([pid, , stat, cpu, ...comm]) => psRow(pid!, stat!, cpu!, comm))
    : [processes];
  const report = [
    `cause: ${verdict.layer}`,
    verdict.detail,
    `step: ${step}; limit ${limitMs} ms; the bound fired ${Math.round(lateMs)} ms late`,
    `driver event loop: max ${Math.round(loopMaxMs)} ms, mean ${Math.round(loopMeanMs)} ms`,
    `server event loop: ${server.loopSamples} samples, max ${server.loopMaxDelayMs} ms, longest silence ${Math.round(server.loopSilentMs)} ms; requests completed: ${server.requests}`,
    // os.freemem excludes inactive and cached memory on macOS, so a low
    // figure there is routine, not memory pressure.
    `host: load ${loadavg()
      .map((load) => load.toFixed(1))
      .join(' ')} on ${cpus().length} CPUs; os.freemem ${Math.round(
      freemem() / 2 ** 20,
    )} MiB`,
    '',
    `worker ${process.pid} and its processes (pid stat cpu command):`,
    ...(listed ? processTree(processes, process.pid) : [processes]),
    '',
    'top CPU on the host:',
    ...top,
    '',
    'protocol in the window (to the moment the bound fired):',
    ...window.map((entry) => line(entry, from)),
    '',
    `server log in the window (${serverLogPath}):`,
    ...(server.lines.length
      ? server.lines
      : [
          serverLog.startsWith('the server log read')
            ? serverLog
            : '(no server log lines in the window)',
        ]),
  ];
  await within(
    'writing stall-evidence.log',
    writeFile(
      testInfo.outputPath('stall-evidence.log'),
      `${report.join('\n')}\n`,
    ).then(() => ''),
    CAPTURE_BUDGET_MS - READ_BUDGET_MS,
  );
  return verdict.layer;
}

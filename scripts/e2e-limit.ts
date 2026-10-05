#!/usr/bin/env bun
/**
 * Machine-wide limit on concurrent browser e2e runs. Every
 * checkout on the machine shares one slot directory, fixed at
 * /tmp/offense-demo-e2e-slots so that TMPDIR (per user on macOS, and stripped by
 * turbo) never splits the pool; turbo.json passes E2E_ENV through. A run
 * claims a slot before starting Playwright and waits, queued, while
 * OFFENSE_DEMO_E2E_CONCURRENCY runs (default 2) already hold one. A claim is an
 * empty file named by slot and pid, so clearing a dead run's claim removes
 * only that run's file, and a crash between create and write cannot leave
 * an unreadable claim. Two runs that claim one slot together both see it,
 * and a run keeps its claim only while no other live run holds that slot.
 *
 *   bun scripts/e2e-limit.ts <command…>
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Held = { readonly slot: number; readonly pid: number };

const DEFAULT_LIMIT = 2;
const DEFAULT_LOCK_DIR = '/tmp/offense-demo-e2e-slots';

/** The settings a run reads; turbo must pass each one through. */
export const E2E_ENV = [
  'OFFENSE_DEMO_E2E_CONCURRENCY',
  'OFFENSE_DEMO_E2E_LOCK_DIR',
  'OFFENSE_DEMO_E2E_POLL_MS',
] as const;

export const lockDir = (
  env: Readonly<Record<string, string | undefined>>,
): string => env.OFFENSE_DEMO_E2E_LOCK_DIR || DEFAULT_LOCK_DIR;

export function readLimit(env: Readonly<Record<string, string | undefined>>) {
  const value = Number(env.OFFENSE_DEMO_E2E_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMIT;
}

const SLOT_FILE = /^slot-(\d+)-(\d+)\.pid$/;

const slotFile = (held: Held): string => `slot-${held.slot}-${held.pid}.pid`;

/** The claims in a slot directory, read from their names. */
export const parseHeld = (names: readonly string[]): Held[] =>
  names.flatMap((name) => {
    const match = SLOT_FILE.exec(name);
    return match ? [{ slot: Number(match[1]), pid: Number(match[2]) }] : [];
  });

/** Which slot to claim, if any, and which claims belong to dead runs. */
export function claimPlan(
  held: readonly Held[],
  limit: number,
  alive: (pid: number) => boolean,
): { readonly claim: number | undefined; readonly stale: readonly Held[] } {
  const stale = held.filter((h) => !alive(h.pid));
  const busy = new Set(held.filter((h) => alive(h.pid)).map((h) => h.slot));
  // The limit is a total of live runs, not a range of slot numbers: runs
  // started under a higher limit still count.
  const claim =
    busy.size >= limit
      ? undefined
      : Array.from({ length: busy.size + 1 }, (_, slot) => slot).find(
          (slot) => !busy.has(slot),
        );
  return { claim, stale };
}

/**
 * Whether a fresh claim stands: no other live run holds its slot, and the
 * live claims, this one included, stay within the limit.
 */
export function keepsClaim(
  held: readonly Held[],
  mine: Held,
  alive: (pid: number) => boolean,
  limit: number,
): boolean {
  const live = held.filter(
    (other) => alive(other.pid) || other.pid === mine.pid,
  );
  return (
    live.length <= limit &&
    !live.some((other) => other.slot === mine.slot && other.pid !== mine.pid)
  );
}

// ------------------------------------------------------------------- edges

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Creates a claim file exclusively: false when anything, a file or a symlink
 * planted at the predicted name, is already there, so nothing is written
 * through it. Other errors are raised.
 */
export function claimFile(file: string): boolean {
  try {
    writeFileSync(file, '', { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function tryClaim(dir: string, limit: number): string | undefined {
  const plan = claimPlan(parseHeld(readdirSync(dir)), limit, isAlive);
  for (const held of plan.stale)
    rmSync(join(dir, slotFile(held)), { force: true });
  if (plan.claim === undefined) return undefined;
  const mine = { slot: plan.claim, pid: process.pid };
  const file = join(dir, slotFile(mine));
  if (!claimFile(file)) return undefined;
  if (keepsClaim(parseHeld(readdirSync(dir)), mine, isAlive, limit))
    return file;
  rmSync(file, { force: true }); // another run took this slot too; look again
  return undefined;
}

async function main(command: readonly string[]): Promise<number> {
  const env = process.env;
  const limit = readLimit(env);
  const dir = lockDir(env);
  // Offset by pid so two runs that withdrew from one slot retry apart.
  const pollMs =
    Number(env.OFFENSE_DEMO_E2E_POLL_MS ?? 5000) + (process.pid % 97);
  mkdirSync(dir, { recursive: true });
  let claimed = tryClaim(dir, limit);
  if (!claimed)
    process.stderr.write(
      `e2e: ${limit} run(s) already hold every slot (OFFENSE_DEMO_E2E_CONCURRENCY=${limit}); queued\n`,
    );
  while (!claimed) {
    await Bun.sleep(pollMs);
    claimed = tryClaim(dir, limit);
  }
  const release = () => rmSync(claimed as string, { force: true });
  const child = Bun.spawn([...command], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => child.kill(signal));
  try {
    return await child.exited;
  } finally {
    release();
  }
}

if (import.meta.main) {
  const command = process.argv.slice(2);
  if (command.length === 0) {
    process.stderr.write('usage: e2e-limit.ts <command…>\n');
    process.exit(2);
  }
  process.exit(await main(command));
}

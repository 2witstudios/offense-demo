/**
 * Port blocks of local slots (ADR 0034), split from slot-model.ts: which
 * ports a slot's app, browser suite and realtime server use, and the claim
 * that reserves a worktree's block on the shared stack.
 */

// realtime (ADR 0031): a dev port distinct from `app`, and an e2e port at
// `e2e + 3` (the fourth of the browser suite's four consecutive ports).
// The main checkout's app port is overridable (APP_PORT_ENV) so several
// projects can run side by side; e2e and realtime keep their offsets.
const defaultMainAppPort = 3000;
const mainPorts = (app: number) => ({
  app,
  e2e: app + 100,
  realtime: app + 11,
});

/** The variable that moves a main checkout's app (and its e2e/realtime) ports. */
export const APP_PORT_ENV = 'OFFENSE_DEMO_APP_PORT';

/** The configured main app port, or the default when unset or empty. */
export function mainAppPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return defaultMainAppPort;
  const port = Number(raw);
  // e2e takes app+100..+103, so the whole range must stay a valid port.
  if (!Number.isInteger(port) || port < 1024 || port > 65_432)
    throw new Error(
      `${APP_PORT_ENV} must be a port number (1024-65432), got "${raw}"`,
    );
  return port;
}
// Worktree block n owns app port 13000+10n, e2e ports 13001+10n..+3, and
// realtime ports 13000+10n+4 (e2e) and 13000+10n+5 (dev).
const portBlockBase = 13_000;
const portBlockSize = 10;
const maxPortBlock = 499;

/** The app, first e2e and realtime dev ports of a main or worktree slot. */
export function slotPorts(
  kind: 'main' | 'worktree',
  portBlock: number | undefined,
  mainApp: number = defaultMainAppPort,
): { readonly app: number; readonly e2e: number; readonly realtime: number } {
  if (kind === 'main') return mainPorts(mainApp);
  if (portBlock === undefined)
    throw new Error('A worktree slot needs a port block');
  const app = portBlockBase + portBlockSize * portBlock;
  return { app, e2e: app + 1, realtime: app + 5 };
}

/**
 * Every port a worktree block reserves: the app, the three web e2e ports,
 * realtime's e2e port (E2E_PORT + 3) and realtime's own dev port.
 */
export const portBlockPorts = (block: number): readonly number[] => {
  const app = portBlockBase + portBlockSize * block;
  return [app, app + 1, app + 2, app + 3, app + 4, app + 5];
};

const portBlockClaim = /^offense-demo-slot port-block=([1-9][0-9]{0,2})$/;

/** The claim stored as the slot database's comment (shared, self-cleaning). */
export function portBlockComment(block: number): string {
  if (!Number.isInteger(block) || block < 1 || block > maxPortBlock)
    throw new Error(`Invalid port block ${block}`);
  return `offense-demo-slot port-block=${block}`;
}

export function parsePortBlockComment(
  comment: string | null | undefined,
): number | undefined {
  const match = portBlockClaim.exec(comment ?? '');
  const block = match ? Number(match[1]) : undefined;
  return block !== undefined && block <= maxPortBlock ? block : undefined;
}

export function pickPortBlock({
  own,
  claimed,
  isFree,
}: {
  readonly own?: number;
  readonly claimed: readonly number[];
  readonly isFree: (block: number) => boolean;
}): number {
  if (own !== undefined) return own;
  const taken = new Set(claimed);
  for (let block = 1; block <= maxPortBlock; block += 1)
    if (!taken.has(block) && isFree(block)) return block;
  throw new Error('No free port block left for a new slot');
}

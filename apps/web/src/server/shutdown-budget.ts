/**
 * How long a stopping server drains before it forces its exit (`start.ts`):
 * in-flight requests, then auth work handed off past its answer (ISSUE-185;
 * a Resend send gives up within 10 s), then the pools. fly.toml's
 * `kill_timeout` must exceed it with margin, so Fly never SIGKILLs a drain
 * that is still inside its budget (ISSUE-214; `verify-deploy-config` checks
 * the two).
 */
export const SHUTDOWN_DRAIN_DEADLINE_MS = 25_000;

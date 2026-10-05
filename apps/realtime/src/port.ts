/**
 * `REALTIME_PORT`, not `PORT`: `apps/web` already reads `PORT` for its own
 * listener, and `bun dev`/`bun dev:agent` run both apps in one environment.
 * The default is distinct from `.env.example`'s commented `PORT=3001`
 * example, so uncommenting only that line without `REALTIME_PORT` cannot
 * collide.
 */
export const DEFAULT_REALTIME_PORT = 3011;

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error(`Invalid REALTIME_PORT: ${value}`);
  return parsed;
}

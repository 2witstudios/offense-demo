import { createHash } from 'node:crypto';
import { createAppError } from '@offense-demo/errors';

const BEARER_PREFIX = 'Bearer ';

const hash = (value: string): string =>
  createHash('sha3-256').update(value).digest('hex');

/**
 * Gates `/api/ops/alerts` and `/api/ops/metrics` behind `OPS_PROBE_TOKEN`
 * (AUTH-7.7): the scheduled probe workflow's bearer credential, and nothing
 * else. Compares SHA3-256 digests rather than the raw strings (ADR 0019's
 * secret-comparison rule), so a byte-length or prefix leak through
 * comparison timing costs an attacker nothing usable.
 */
export function requireProbeToken(request: Request, token: string): void {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith(BEARER_PREFIX)) throw createAppError('AUTHENTICATION');
  const provided = header.slice(BEARER_PREFIX.length);
  if (hash(provided) !== hash(token)) throw createAppError('AUTHENTICATION');
}

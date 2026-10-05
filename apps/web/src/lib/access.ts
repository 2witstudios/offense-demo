import { redirect } from 'next/navigation';
import type { Identity } from '@offense-demo/auth';
import { createAppError } from '@offense-demo/errors';
import {
  decideAccess,
  requestedPath,
  requirementFor,
  type SearchParams,
} from '../features/access/decision';
import { requestIdentity } from './request-session';

/**
 * Server-component guard: resolves the durable session from this request's
 * cookies and redirects when the area's requirement is unmet. Call it from
 * every guarded page (and any server entrypoint under one) with that page's
 * own path and search params, so the return trip keeps the query. The
 * requirement comes from the guarded-area table, never the caller. The
 * proxy's cookie check is only an early hint, never this check.
 */
export async function requireAccess(
  path: string,
  searchParams: Promise<SearchParams>,
): Promise<Identity> {
  const requirement = requirementFor(path);
  // A page outside every guarded area calling the guard is a wiring error.
  if (requirement === null) throw createAppError('INTERNAL');
  const identity = await requestIdentity();
  const decision = decideAccess({
    identity,
    path: requestedPath(path, await searchParams),
    requirement,
  });
  // An outage renders the error boundary (retryable), never a sign-out.
  if (decision.kind === 'unavailable') throw createAppError('INFRASTRUCTURE');
  if (decision.kind === 'redirect') redirect(decision.to);
  return identity;
}

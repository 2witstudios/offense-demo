import type { Logger } from '@offense-demo/logger';
import { createAppError } from '@offense-demo/errors';
import { parseUsername, type Identity } from '@offense-demo/auth';
import type { UsernameClaim } from '@offense-demo/db';
import { z } from 'zod';
import { consumeOrThrow, type AuthRateLimiter } from '../auth/rate-limit';
import {
  handleOperation,
  parseValidated,
  readJson,
  requireSameOrigin,
  requireSignedIn,
} from '../../server/http';

/** Enough for a person retrying a typo; far below what enumerates names. */
const CLAIM_RULE = { windowSeconds: 60, max: 10 } as const;

type UsernameDependencies = {
  readonly logger: Logger;
  readonly origin: () => string;
  /** Principal resolution from the request's cookies only. */
  readonly identify: (request: Request) => Promise<Identity>;
  readonly limiter: () => AuthRateLimiter;
  readonly claim: (input: {
    userId: string;
    username: string;
  }) => Promise<UsernameClaim>;
};

/** The two stable 409 answers the onboarding screen tells apart. */
const CONFLICTS = {
  taken: {
    code: 'USERNAME_TAKEN',
    message: 'That username is already taken',
  },
  'already-set': {
    code: 'USERNAME_ALREADY_SET',
    message: 'This account already has a username',
  },
} as const;

const conflict = (kind: keyof typeof CONFLICTS, requestId: string) =>
  Response.json({ error: { ...CONFLICTS[kind], requestId } }, { status: 409 });

/** The body is exactly `{ username }`: any other field is a refusal. */
const claimBody = z.strictObject({ username: z.unknown() });

async function readClaimedName(request: Request): Promise<string> {
  const { username } = parseValidated(claimBody, await readJson(request));
  const parsed = parseUsername(username);
  if (!parsed.ok) throw createAppError('VALIDATION');
  return parsed.username;
}

const respond = (
  outcome: UsernameClaim,
  username: string,
  id: string,
): Response => {
  switch (outcome.kind) {
    case 'claimed':
      return Response.json({ username }, { status: 201 });
    case 'unchanged':
      return Response.json({ username });
    case 'taken':
    case 'already-set':
      return conflict(outcome.kind, id);
    case 'unknown-user':
      throw createAppError('AUTHENTICATION');
  }
};

/**
 * POST /api/account/username: the only way an account acquires a username.
 * Gate order is ADR 0020: route (same origin), Principal (session cookie),
 * authorization (a signed-in user, never a body-supplied id), atomic rate
 * limit, and only then durable work. The body is exactly `{ username }`.
 */
export function createUsernameHandler(dependencies: UsernameDependencies) {
  return (request: Request) =>
    handleOperation(
      dependencies.logger,
      request,
      'account.username.claim',
      async (id) => {
        requireSameOrigin(request, dependencies.origin());
        const identity = requireSignedIn(await dependencies.identify(request));
        const { userId } = identity.principal;
        await consumeOrThrow(
          dependencies.limiter(),
          `account:username:${userId}`,
          CLAIM_RULE,
        );
        const username = await readClaimedName(request);
        return respond(
          await dependencies.claim({ userId, username }),
          username,
          id,
        );
      },
    );
}

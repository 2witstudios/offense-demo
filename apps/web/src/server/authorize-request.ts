import {
  authorize,
  toAuthorizationInput,
  type Identity,
} from '@offense-demo/auth';
import type { Database, ResourceRef } from '@offense-demo/db';
import { createAppError, type AppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import {
  capabilityMetadata,
  type Capability,
  type DenyReason,
} from '@offense-demo/protocol';

type AuthorizeRequestDependencies = {
  /** The fact loader, `database.loadAuthorizationContext` in production. */
  readonly loadContext: Database['loadAuthorizationContext'];
  /** The operation's request-scoped logger, which carries its operation. */
  readonly logger: Logger;
};

/**
 * The web composition of the authorization core (ADR 0048 section 5),
 * bound to its loader and the operation's logger. `authorizeRequest` is
 * the only way an operation reaches a protected read: it decides one gate,
 * before any other check, and returns the loaded resource or throws the
 * public error.
 *
 * - An `unavailable` identity answers the existing 503 (`INFRASTRUCTURE`)
 *   without loading or deciding.
 * - A provisional account (no username yet) holds no member allowance: it
 *   is refused before loading. A guarded page never gets this far, since
 *   `requireAccess` already sent it to onboarding.
 * - A denied read answers `NOT_FOUND` for every principal, exactly like a
 *   resource that does not exist, so no existence oracle is exposed.
 * - A denied non-read answers `AUTHENTICATION` for an anonymous visitor
 *   and `AUTHORIZATION` for everyone else.
 *
 * The reason never reaches the response; it goes only to the `denyReason`
 * field of `authz.denied`.
 */
export function createAuthorizeRequest({
  loadContext,
  logger,
}: AuthorizeRequestDependencies) {
  return async function authorizeRequest(
    identity: Identity,
    capability: Capability,
    resourceRef: ResourceRef,
  ) {
    if (identity.state === 'unavailable')
      throw createAppError('INFRASTRUCTURE');
    const refuse = (denyReason: DenyReason): AppError => {
      logger.log('authz.denied', { denyReason }, 'Authorization denied');
      if (capabilityMetadata[capability].read)
        return createAppError('NOT_FOUND');
      return createAppError(
        identity.state === 'anonymous' ? 'AUTHENTICATION' : 'AUTHORIZATION',
      );
    };
    if (identity.state === 'provisional') throw refuse('missing-capability');
    const { principal } = identity;
    const projection = await loadContext({
      userId: principal.kind === 'user' ? principal.userId : null,
      resourceRef,
    });
    const input = toAuthorizationInput(projection, principal);
    if (input === null) throw createAppError('NOT_FOUND');
    const decision = authorize({ ...input, capability });
    if (!decision.allow) throw refuse(decision.reason);
    return input.resource;
  };
}

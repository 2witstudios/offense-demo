import {
  capabilityMetadata,
  type Capability,
  type DenyReason,
  type ResourceKind,
} from '@offense-demo/protocol';
import type { Principal } from './index';

/** What a capability is asked of, built from loaded rows, never client input. */
type Resource = { readonly kind: ResourceKind };

/** A fact that denies whatever the allowances say (rule 1). */
type DenyFact = Extract<DenyReason, 'account-erased'>;

/** Facts about the principal and the resource, loaded fresh per request. */
type AuthorizationContext = { readonly denyFacts: readonly DenyFact[] };

type AuthorizationInput = {
  readonly principal: Principal;
  readonly capability: Capability;
  readonly resource: Resource;
  readonly context: AuthorizationContext;
};

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: DenyReason };

const allow: Decision = { allow: true };
const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

/**
 * Rule 3, the fixed allowances: code, not data, one per capability. The
 * principal reaching here is a signed-in member; a provisional account
 * (no username yet) is answered by the delivery layer before any decision
 * (`authorizeRequest` in apps/web). A creator or member fact, when a
 * product adds one, allows capabilities on that resource only.
 */
const fixedAllowances: Readonly<
  Record<Capability, (input: AuthorizationInput) => boolean>
> = {
  'project.create': ({ principal }) => principal.kind === 'user',
  'project.list': ({ principal }) => principal.kind === 'user',
};

/**
 * The one access decision (ADR 0048 section 3), pure. The rules run in
 * order and the first that decides gives the reason:
 *
 * 0. A resource kind outside the capability's `resourceKinds` (or a
 *    capability outside the vocabulary) is `denied`, so nothing below can
 *    allow such a request.
 * 1. A deny fact denies with that fact, dominating every allowance.
 * 2. (Service principals: deferred to their first consumer.)
 * 3. The capability's fixed allowance allows.
 * 4. Otherwise `unauthenticated` for an anonymous principal and
 *    `missing-capability` for everyone else.
 */
export function authorize(input: AuthorizationInput): Decision {
  const { principal, capability, resource, context } = input;
  if (
    !Object.hasOwn(capabilityMetadata, capability) ||
    !capabilityMetadata[capability].resourceKinds.includes(resource.kind)
  )
    return deny('denied');
  const [fact] = context.denyFacts;
  if (fact !== undefined) return deny(fact);
  if (fixedAllowances[capability](input)) return allow;
  return deny(
    principal.kind === 'anonymous' ? 'unauthenticated' : 'missing-capability',
  );
}

/**
 * What `@offense-demo/db`'s `loadAuthorizationContext` returns, restated
 * structurally: `@offense-demo/db` may not import `@offense-demo/auth`, so the two agree on
 * shape, not on a shared type. `resource` is null when the reference names
 * nothing that exists.
 */
export type AuthorizationProjection = {
  readonly resource: { readonly kind: ResourceKind } | null;
  /** The principal's user row is tombstoned (`users.deleted_at`). */
  readonly accountErased: boolean;
};

/**
 * Builds the resource and context `authorize` takes from a loaded
 * projection, or null when the resource does not exist (the caller answers
 * it exactly as it answers a denied read).
 */
export function toAuthorizationInput(
  projection: AuthorizationProjection,
  principal: Principal,
): Pick<AuthorizationInput, 'principal' | 'resource' | 'context'> | null {
  if (projection.resource === null) return null;
  return {
    principal,
    resource: { kind: projection.resource.kind },
    context: {
      denyFacts:
        principal.kind === 'user' && projection.accountErased
          ? ['account-erased']
          : [],
    },
  };
}

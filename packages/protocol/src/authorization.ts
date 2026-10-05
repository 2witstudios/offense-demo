import { z } from 'zod';

/**
 * The authorization vocabulary (ADR 0048 section 2): what can be asked
 * (capabilities), of what (resource kinds), and why an answer was no (deny
 * reasons). `@offense-demo/auth` decides over it, `@offense-demo/db` loads facts keyed by
 * it and `apps/web` maps decisions to public errors with it. A product adds
 * a capability by adding a row here, its fixed allowance in `@offense-demo/auth`
 * and, for a new resource kind, the loader columns in `@offense-demo/db`.
 */

/**
 * Resource kinds. `projects` is the collection of the example `project`
 * aggregate (`@offense-demo/domain`): the resource asked when creating or listing
 * projects, `{ kind: 'projects' }`. A kind naming one row (`project`, by
 * id) arrives with the first table that stores it.
 */
export const resourceKinds = ['projects'] as const;
export type ResourceKind = (typeof resourceKinds)[number];

/** Every capability a principal can be asked about; closed. */
export const capabilities = ['project.create', 'project.list'] as const;
export const capabilitySchema = z.enum(capabilities);
export type Capability = z.infer<typeof capabilitySchema>;

export type CapabilityMetadata = {
  /** The resource kinds this capability may be asked of (rule 0). */
  readonly resourceKinds: readonly ResourceKind[];
  /** A read: a denial answers NOT_FOUND, never revealing existence. */
  readonly read: boolean;
};

/** Per-capability metadata; one row per capability, checked by the type. */
export const capabilityMetadata: Readonly<
  Record<Capability, CapabilityMetadata>
> = {
  'project.create': { resourceKinds: ['projects'], read: false },
  'project.list': { resourceKinds: ['projects'], read: true },
};

/**
 * Why a decision denied: `denied` (the capability cannot be asked of that
 * resource kind), `account-erased` (the principal's account is
 * tombstoned), `unauthenticated` (anonymous, no allowance) and
 * `missing-capability` (signed in, no allowance). Every value has privacy
 * category `none`; the union is the `denyReason` log field's vocabulary
 * (ADR 0019).
 */
export const denyReasons = [
  'denied',
  'account-erased',
  'unauthenticated',
  'missing-capability',
] as const;
export type DenyReason = (typeof denyReasons)[number];

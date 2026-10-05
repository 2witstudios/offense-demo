import { createAppError } from '@offense-demo/errors';
/**
 * Placeholder permissions for a new product: replace them with the
 * product's own `<resource>:<action>` vocabulary. Each permission stands
 * alone: none implies another, so `app:write` does not grant `app:read`.
 */
export type Permission = 'app:read' | 'app:write';
export type Principal =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly permissions: readonly Permission[];
    }
  | {
      readonly kind: 'service';
      readonly serviceId: string;
      readonly permissions: readonly Permission[];
    };
/** Principal permissions must come from a trusted authentication adapter, never request JSON. */
export function requirePermission(
  principal: Principal,
  permission: Permission,
): void {
  if (principal.kind === 'anonymous') throw createAppError('AUTHENTICATION');
  if (!principal.permissions.includes(permission))
    throw createAppError('AUTHORIZATION');
}
export { parseUsername } from './username';
export { resolveIdentity, type Identity } from './identity';

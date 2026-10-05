/**
 * Who is asking. A principal carries no permissions (ADR 0048): what it
 * may do is decided by `authorize` from the rules and facts loaded fresh
 * for each request. Service principals arrive with their first consumer.
 */
export type Principal =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'user'; readonly userId: string };
export { parseUsername } from './username';
export { resolveIdentity, type Identity } from './identity';
export { authorize, toAuthorizationInput } from './authorize';

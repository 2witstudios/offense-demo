import type { Principal } from './index';

/** Facts about a durable session, verified by the injected reader. */
export type VerifiedSession = {
  readonly userId: string;
  readonly emailVerified: boolean;
  readonly username: string | null;
  /** UTC ISO instant. */
  readonly expiresAt: string;
};

/**
 * Reads the durable session named by the request's cookies. The adapter owns
 * cookie signature checks and the database lookup; null means no live
 * session. It receives only the raw Cookie header.
 */
export type SessionReader = (cookie: string) => Promise<VerifiedSession | null>;

const anonymous = { kind: 'anonymous' } as const;

/**
 * Who is asking, and how far through onboarding: anonymous visitors, verified
 * accounts still choosing a username (`provisional`), and accounts with a
 * public identity (`member`). What each may do is `authorize`'s answer.
 */
type AnonymousPrincipal = Extract<Principal, { kind: 'anonymous' }>;
type UserPrincipal = Extract<Principal, { kind: 'user' }>;

export type Identity =
  | { readonly state: 'anonymous'; readonly principal: AnonymousPrincipal }
  /** The session store could not be read: fail closed, but not as signed out. */
  | { readonly state: 'unavailable'; readonly principal: AnonymousPrincipal }
  | { readonly state: 'provisional'; readonly principal: UserPrincipal }
  | {
      readonly state: 'member';
      readonly username: string;
      readonly principal: UserPrincipal;
    };

const ANONYMOUS: Identity = { state: 'anonymous', principal: anonymous };
const UNAVAILABLE: Identity = { state: 'unavailable', principal: anonymous };

/**
 * Principal resolution from request cookies (ADR 0020, gate 2). Only the
 * cookie header enters; the identity derives from verified facts alone, so
 * request-supplied roles or identity fields cannot matter. An unreadable
 * store resolves `unavailable`: no principal (the gate fails closed) and
 * distinguishable from a signed-out visitor, so callers can
 * answer 503 and report the outage instead of sending members to sign-in.
 */
export async function resolveIdentity({
  cookie,
  readSession,
  now,
}: {
  readonly cookie: string | null;
  readonly readSession: SessionReader;
  readonly now: () => string;
}): Promise<Identity> {
  if (!cookie) return ANONYMOUS;
  let found: VerifiedSession | null;
  try {
    found = await readSession(cookie);
  } catch {
    return UNAVAILABLE;
  }
  if (!found || found.emailVerified !== true) return ANONYMOUS;
  const expires = Date.parse(found.expiresAt);
  if (Number.isNaN(expires) || expires <= Date.parse(now())) return ANONYMOUS;
  // The reader is an adapter boundary: only a non-empty string username
  // makes a member, whatever else the lookup returned.
  const { userId, username } = found;
  return typeof username === 'string' && username !== ''
    ? {
        state: 'member',
        username,
        principal: { kind: 'user', userId },
      }
    : {
        state: 'provisional',
        principal: { kind: 'user', userId },
      };
}

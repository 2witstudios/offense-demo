import type { BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';

const OWNED_PASSKEY_PATHS = new Set([
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);

/**
 * AUTH-6.3-AC4: "bypassing passkey credential ownership" is one of the four
 * named negative controls, but the only code that refuses a rename or
 * removal of someone else's passkey is `requireResourceOwnership`, vendored
 * inside `@better-auth/passkey` (node_modules, untracked) — no repo-owned
 * source implements it, so it cannot be sabotaged and restored as a
 * reviewable diff. This app-owned guard duplicates the same guarantee ("you
 * may only rename or remove a passkey `userId` matches your session's") in
 * front of it, so the guarantee has a repo-owned enforcement point that
 * `scripts/negative-controls.ts` can sabotage directly instead of citing an
 * existing test as a substitute.
 *
 * Runs as a global `hooks.before`, ahead of the endpoint's own `use` chain
 * (see `freshSessionGatePlugin`), so `ctx.context.session` is not yet
 * populated here; `getSessionFromCtx` reads it directly the same way
 * `sessionMiddleware` itself does.
 */
export const passkeyOwnershipGuardPlugin: BetterAuthPlugin = {
  id: 'offense-demo-passkey-ownership-guard',
  hooks: {
    before: [
      {
        matcher: (context) =>
          context.path !== undefined && OWNED_PASSKEY_PATHS.has(context.path),
        handler: createAuthMiddleware(async (context) => {
          const session = await getSessionFromCtx(context);
          if (!session?.session) throw new APIError('UNAUTHORIZED');
          const id = (context.body as { id?: unknown } | undefined)?.id;
          if (typeof id !== 'string') return;
          const passkey = (await context.context.adapter.findOne({
            model: 'passkey',
            where: [{ field: 'id', value: id }],
          })) as { userId?: string } | null;
          // A nonexistent id is left to the vendor endpoint's own
          // NOT_FOUND; only ownership is this guard's guarantee.
          if (passkey && passkey.userId !== session.user.id)
            throw new APIError('UNAUTHORIZED', {
              code: 'YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY',
            });
        }),
      },
    ],
  },
};

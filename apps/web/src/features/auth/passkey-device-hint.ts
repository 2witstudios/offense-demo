import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';

// The spec supports platform and roaming authenticators, so registration
// cannot pin `authenticatorAttachment: 'platform'`. Without any preference,
// though, Chrome ranks a phone (hybrid QR) alongside the device and opens
// the QR sheet when no platform store is ready. The WebAuthn L3
// `client-device` hint is advisory: the browser offers the device's own
// store first and still lets the person pick a security key or a phone.
// `@better-auth/passkey` has no option for hints, so they are added to the
// options it returns; SimpleWebAuthn passes them through to the browser.
const CEREMONY_OPTION_PATHS = new Set([
  '/passkey/generate-register-options',
  '/passkey/generate-authenticate-options',
]);

const DEVICE_FIRST_HINTS = ['client-device'] as const;

export const passkeyDeviceHintPlugin: BetterAuthPlugin = {
  id: 'offense-demo-passkey-device-hint',
  hooks: {
    after: [
      {
        matcher: (context) =>
          context.path !== undefined && CEREMONY_OPTION_PATHS.has(context.path),
        handler: createAuthMiddleware(async (context) => {
          const returned = context.context.returned;
          if (
            isAPIError(returned) ||
            typeof returned !== 'object' ||
            returned === null ||
            Array.isArray(returned)
          )
            return;
          return context.json({ ...returned, hints: DEVICE_FIRST_HINTS });
        }),
      },
    ],
  },
};

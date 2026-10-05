import { systemClock } from '@offense-demo/clock';
import { readAuthConfig } from '@offense-demo/config';
import {
  authTestEnv,
  composeAuthServer,
  memoryTables,
} from './auth-server.test-support';
import { deriveRecipientSubkey, recipientKey } from './recipient-key';
import type { AuthEmailMessage } from './server';

const origin = authTestEnv.PUBLIC_APP_URL;
export const oldEmail = 'player@offense-demo.example.com';
export const newEmail = 'moved@offense-demo.example.com';

export const linkIn = (message: AuthEmailMessage | undefined) =>
  new URL(message?.text.match(/https?:\/\/\S+/)?.[0] ?? 'http://x.invalid');

/**
 * The composed auth server over in-memory tables, signed in through a real
 * magic link. Expiry is stamped from the injected clock and checked by
 * Better Auth against the ambient one, so this suite injects the system
 * clock.
 */
export async function signedIn(envOverrides: Partial<typeof authTestEnv> = {}) {
  const db = memoryTables();
  const sent: AuthEmailMessage[] = [];
  // Every address deliverable until a test says otherwise.
  const ledger = {
    mode: 'deliverable' as 'deliverable' | 'suppressed' | 'down',
    /** Per-address answers, in call order, ahead of `mode`. */
    answers: new Map<string, boolean[]>(),
  };
  const server = composeAuthServer(
    {
      config: readAuthConfig({ ...authTestEnv, ...envOverrides }),
      clock: systemClock,
      emailSender: { send: async (message) => void sent.push(message) },
      ledger: {
        isSuppressed: async (key) => {
          if (ledger.mode === 'down') throw new Error('ledger unreachable');
          return (
            ledger.answers.get(key)?.shift() ?? ledger.mode === 'suppressed'
          );
        },
        record: async () => {},
      },
    },
    db,
  );
  const call = (path: string, init: RequestInit = {}, cookie = '') =>
    server.instance.handler(
      new Request(`${origin}/api/auth${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          origin,
          ...(cookie ? { cookie } : {}),
          ...init.headers,
        },
      }),
    );
  const signIn = async (address: string) => {
    await call('/sign-in/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email: address }),
    });
    const token = linkIn(sent.at(-1)).searchParams.get('token');
    const response = await call(`/magic-link/verify?token=${token}`);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  };
  const cookie = await signIn(oldEmail);
  const requestChange = (email: string) =>
    call(
      '/change-email',
      { method: 'POST', body: JSON.stringify({ newEmail: email }) },
      cookie,
    );
  const redeem = (token: string) =>
    call('/email-change/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  const email = () => (db.user[0] as { email: string }).email;
  /** The ledger answers these lookups for `address`, in order, then `mode`. */
  const suppress = (address: string, ...answers: boolean[]) =>
    ledger.answers.set(
      recipientKey(
        deriveRecipientSubkey(authTestEnv.RECIPIENT_HASH_SECRET),
        address,
      ),
      answers,
    );
  return { db, sent, ledger, suppress, signIn, requestChange, redeem, email };
}

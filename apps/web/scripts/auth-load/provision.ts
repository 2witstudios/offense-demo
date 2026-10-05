import { createId } from '@paralleldrive/cuid2';
import { simulatedClients } from './client-identity';
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createSoftwareCredential,
  type SoftwareCredential,
} from '../../integration/webauthn-authenticator';
import {
  cookieHeader,
  createHttpClient,
  tokenFromMail,
  waitForMail,
} from './http-client';

export type SessionAccount = {
  readonly email: string;
  readonly cookie: string;
};
export type PasskeyAccount = {
  readonly email: string;
  readonly credential: SoftwareCredential;
};

const rpID = 'localhost';
const mergeCookies = (...parts: readonly string[]) =>
  parts.filter((part) => part !== '').join('; ');

/**
 * Signs up one fresh account through the real magic-link and confirm-page
 * routes, exactly as a person does: request the link, read it from the
 * run's private mail sink, redeem it.
 */
async function signUp(
  http: ReturnType<typeof createHttpClient>,
  mailPorts: readonly [number, number],
  clientHeader: Record<string, string>,
): Promise<SessionAccount> {
  const email = `auth-load-${createId()}@example.test`;
  const requested = await http.jsonPost(
    '/api/auth/sign-in/magic-link',
    { email },
    clientHeader,
  );
  if (!requested.ok)
    throw new Error(
      `Provisioning sign-up was refused: HTTP ${requested.status}`,
    );
  const mail = await waitForMail(mailPorts, email);
  const response = await http.formPost(
    '/auth/confirm',
    { token: tokenFromMail(mail.text), callbackURL: '/app' },
    clientHeader,
  );
  const cookie = cookieHeader(response);
  if (response.status >= 400 || cookie === '')
    throw new Error(`Provisioning confirm failed: HTTP ${response.status}`);
  return { email, cookie };
}

/** Registers a software passkey credential for an already-signed-in account. */
async function enrollPasskey(
  http: ReturnType<typeof createHttpClient>,
  originUrl: string,
  cookie: string,
): Promise<SoftwareCredential> {
  const optionsResponse = await http.get(
    '/api/auth/passkey/generate-register-options',
    { cookie },
  );
  const options = (await optionsResponse.json()) as { challenge: string };
  const credential = await createSoftwareCredential();
  const registration = buildRegistrationResponse({
    credential,
    challenge: options.challenge,
    origin: originUrl,
    rpID,
  });
  const verify = await http.jsonPost(
    '/api/auth/passkey/verify-registration',
    { response: registration, name: 'Load client' },
    { cookie: mergeCookies(cookie, cookieHeader(optionsResponse)) },
  );
  if (!verify.ok)
    throw new Error(`Passkey enrollment failed: HTTP ${verify.status}`);
  return credential;
}

/**
 * The load run's fixed population, created before the timed clock starts:
 * `sessionAccountCount` signed-in accounts for the protected-read segment,
 * `passkeyAccountCount` accounts with one pre-enrolled software passkey
 * each for the passkey-assertion segment ("using pre-enrolled load
 * credentials", AUTH-6.7 AC4). Provisioning itself is sequential per
 * account (the mail sink is matched by address, not arrival order, so this
 * need not be as careful as the integration suites' shared-mailbox
 * ordering) but accounts are independent, so callers may run several
 * provisioning batches concurrently if a larger population is needed.
 */
export async function provisionPopulation({
  originUrl,
  mailPorts,
  sessionAccountCount,
  passkeyAccountCount,
}: {
  readonly originUrl: string;
  readonly mailPorts: readonly [number, number];
  readonly sessionAccountCount: number;
  readonly passkeyAccountCount: number;
}): Promise<{
  readonly sessionAccounts: readonly SessionAccount[];
  readonly passkeyAccounts: readonly PasskeyAccount[];
}> {
  const http = createHttpClient(originUrl);
  // A distinct simulated client per sign-up: the shipped per-client magic-
  // link rule (3/60s) would otherwise refuse the fourth provisioning
  // sign-up onward if they all shared one identity.
  const provisioningClients = simulatedClients(
    sessionAccountCount + passkeyAccountCount,
  );
  let nextClient = 0;
  const clientHeader = () => ({
    'x-forwarded-for': provisioningClients[nextClient++]!,
  });
  const sessionAccounts: SessionAccount[] = [];
  for (let index = 0; index < sessionAccountCount; index += 1)
    sessionAccounts.push(await signUp(http, mailPorts, clientHeader()));
  const passkeyAccounts: PasskeyAccount[] = [];
  for (let index = 0; index < passkeyAccountCount; index += 1) {
    const account = await signUp(http, mailPorts, clientHeader());
    const credential = await enrollPasskey(http, originUrl, account.cookie);
    passkeyAccounts.push({ email: account.email, credential });
  }
  return { sessionAccounts, passkeyAccounts };
}

/** One passkey-authentication ceremony against an already-enrolled credential. */
export async function assertPasskey(
  http: ReturnType<typeof createHttpClient>,
  originUrl: string,
  credential: SoftwareCredential,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const optionsResponse = await http.get(
    '/api/auth/passkey/generate-authenticate-options',
    headers,
    signal,
  );
  const options = (await optionsResponse.json()) as { challenge: string };
  const assertion = await buildAuthenticationResponse({
    credential,
    challenge: options.challenge,
    origin: originUrl,
    rpID,
  });
  return http.jsonPost(
    '/api/auth/passkey/verify-authentication',
    { response: assertion },
    { ...headers, cookie: cookieHeader(optionsResponse) },
    signal,
  );
}

/** A caller of one running AUTH-6.7 origin, over the self-signed edge. */
export function createHttpClient(originUrl: string) {
  const fetchInsecure = (path: string, init: RequestInit = {}) =>
    fetch(`${originUrl}${path}`, {
      redirect: 'manual',
      ...init,
      tls: { rejectUnauthorized: false },
    } as RequestInit);

  const jsonPost = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    fetchInsecure(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: originUrl,
        ...headers,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

  const formPost = (
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    fetchInsecure(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: originUrl,
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });

  const get = (
    path: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) => fetchInsecure(path, { headers, ...(signal ? { signal } : {}) });

  return { fetchInsecure, jsonPost, formPost, get };
}

export const cookieHeader = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

const TOKEN_LINK = /https?:\/\/\S+/;

/** The `token` query parameter from a captured mail's plain-text body. */
export function tokenFromMail(mailText: string): string {
  const link = mailText.match(TOKEN_LINK)?.[0];
  if (!link) throw new Error('No link in captured mail');
  return new URL(link).searchParams.get('token') ?? '';
}

type CapturedMail = { readonly to: string; readonly text: string };

/** Polls both instances' private mail sinks until `to`'s mail arrives. */
export async function waitForMail(
  mailPorts: readonly [number, number],
  to: string,
  attempts = 40,
): Promise<CapturedMail> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const port of mailPorts) {
      const response = await fetch(
        `http://127.0.0.1:${port}/mails?to=${encodeURIComponent(to)}`,
      );
      const mails = (await response.json()) as CapturedMail[];
      if (mails.length > 0) return mails[mails.length - 1]!;
    }
    await Bun.sleep(100);
  }
  throw new Error(`No mail captured for ${to}`);
}

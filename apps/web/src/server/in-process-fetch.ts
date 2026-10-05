type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A Request needs an absolute URL; the handlers never read its host. */
const IN_PROCESS = 'http://in-process.invalid';

/**
 * A form action's transport to the equivalent API route: the route's
 * handler called directly, carrying the browser request's own headers (its
 * Origin, session cookie and the ingress's client identity), so every gate
 * of that route still runs. The form's own body headers are dropped; the
 * call's init supplies the route's.
 */
export const inProcessFetch =
  (
    handler: (request: Request) => Promise<Response>,
    incoming: Headers,
  ): FetchLike =>
  (url, init) => {
    const headers = new Headers(incoming);
    for (const name of ['content-length', 'content-type', 'transfer-encoding'])
      headers.delete(name);
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    return handler(new Request(new URL(url, IN_PROCESS), { ...init, headers }));
  };

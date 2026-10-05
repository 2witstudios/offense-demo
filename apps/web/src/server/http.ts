import { createAppError, toPublicError } from '@offense-demo/errors';
import {
  currentTraceId,
  extractTraceContext,
  requestId,
  withSpan,
} from '@offense-demo/observability';
import type { Identity } from '@offense-demo/auth';
import type { Logger } from '@offense-demo/logger';
import { type ZodType } from 'zod';
import { CLIENT_ID_HASH_HEADER } from '../features/auth/client-ip';

/** An `Identity` once anonymous and unavailable are ruled out. */
export type SignedInIdentity = Extract<
  Identity,
  { state: 'provisional' | 'member' }
>;

/**
 * The Principal half of ADR 0020's gates, common to every route that needs
 * a session at all: a session-store outage is retryable (`INFRASTRUCTURE`),
 * never "signed out"; an anonymous visitor is `AUTHENTICATION`. A route
 * that requires a full member (not merely signed in) narrows the result
 * itself.
 */
export function requireSignedIn(identity: Identity): SignedInIdentity {
  if (identity.state === 'unavailable') throw createAppError('INFRASTRUCTURE');
  if (identity.state === 'anonymous') throw createAppError('AUTHENTICATION');
  return identity;
}

/** Single trust-boundary entry for untrusted payloads; failures map to VALIDATION. */
export function parseValidated<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw createAppError('VALIDATION', undefined, result.error);
  return result.data;
}
/**
 * The one wrapper every route handler runs in: correlation and no-store
 * headers, a request-scoped child of the injected logger, completion and
 * failure logging, and the public error contract for anything thrown.
 */
export async function handleOperation(
  baseLogger: Logger,
  request: Request,
  operation: string,
  handler: (id: string, logger: Logger) => Promise<Response>,
): Promise<Response> {
  const id = requestId(request.headers.get('x-request-id'));
  const start = performance.now();
  return withSpan(
    operation,
    { 'request.id': id },
    async () => {
      const logger = baseLogger.child({
        requestId: id,
        traceId: currentTraceId(),
        operation,
      });
      try {
        request.signal.throwIfAborted();
        const response = await handler(id, logger);
        response.headers.set('x-request-id', id);
        response.headers.set('Cache-Control', 'no-store');
        logger.log(
          'http.request.completed',
          {
            durationMs: Math.round(performance.now() - start),
            status: response.status,
            // The ingress's keyed hash of the client identity
            // (apps/web/src/server/ingress.ts), present only when it resolved
            // one; never the raw address, which ADR 0019's allowlist omits.
            clientIdHash:
              request.headers.get(CLIENT_ID_HASH_HEADER) ?? undefined,
          },
          'Request completed',
        );
        return response;
      } catch (error) {
        // Client cancellation is expected traffic, not a failure signal.
        if (request.signal.aborted) {
          logger.log(
            'http.request.cancelled',
            {
              durationMs: Math.round(performance.now() - start),
              errorCode: 'REQUEST_CANCELLED',
            },
            'Request cancelled before completion',
          );
          return new Response(null, {
            status: 499,
            headers: { 'x-request-id': id, 'Cache-Control': 'no-store' },
          });
        }
        const mapped = toPublicError(error, id);
        if (mapped.body.error.invariantId !== undefined)
          logger.log(
            'invariant.violated',
            { invariantId: mapped.body.error.invariantId },
            'Invariant violated',
          );
        logger.log(
          'http.request.failed',
          {
            durationMs: Math.round(performance.now() - start),
            errorCode: mapped.body.error.code,
            // AUTH-7.7: the auth 5xx-rate alert reads this alongside
            // http.request.completed's status; a thrown failure otherwise
            // left no status on the event stream.
            status: mapped.status,
          },
          'Request failed',
        );
        return Response.json(mapped.body, {
          status: mapped.status,
          headers: { 'x-request-id': id, 'Cache-Control': 'no-store' },
        });
      }
    },
    extractTraceContext(request.headers),
  );
}
/**
 * Fail-closed origin gate for state changes. The Origin must be this app's;
 * everything else, including the opaque `Origin: null` a no-referrer page's
 * form submission sends, is refused. Only the no-referrer confirmation
 * routes may accept that opaque origin, through `requireSameOriginForm`
 * below — never this one.
 */
export function requireSameOrigin(request: Request, origin: string) {
  if (request.headers.get('origin') !== new URL(origin).origin)
    throw createAppError('AUTHORIZATION');
}

/**
 * Origin gate for form posts from pages served with `Referrer-Policy:
 * no-referrer`: `/auth/confirm` and `/auth/confirm-email`, the emailed-link
 * confirmation pages (`confirm-page-shared.ts`'s `pageHeaders`). Browsers
 * then send `Origin: null` even to the same origin, so that value is
 * accepted only with `Sec-Fetch-Site: same-origin`, a header page script
 * cannot set. A sandboxed or cross-site sender reports something else and is
 * still refused. No other route may use this: every other caller needs the
 * strict `requireSameOrigin` above.
 */
export function requireSameOriginForm(request: Request, origin: string) {
  if (
    request.headers.get('origin') === 'null' &&
    request.headers.get('sec-fetch-site') === 'same-origin'
  )
    return;
  requireSameOrigin(request, origin);
}

/**
 * Same-origin gate for safe, side-effect-free reads. It refuses only POSITIVE
 * cross-site evidence: fetch metadata other than same-origin/none (direct
 * navigation), or an Origin that differs. A missing Origin must pass because
 * browsers omit it on same-origin GETs. A request carrying neither header is
 * therefore allowed — non-browser clients, but also a legacy browser's
 * cross-site no-cors GET, whose response stays unreadable without CORS.
 * Do not reuse this to guard state changes or sensitive reads; those need a
 * fail-closed check such as requireSameOrigin or an authenticated principal.
 */
export function requireSameOriginRead(request: Request, origin: string) {
  const site = request.headers.get('sec-fetch-site');
  const claimed = request.headers.get('origin');
  if (
    (site !== null && site !== 'same-origin' && site !== 'none') ||
    (claimed !== null && claimed !== new URL(origin).origin)
  )
    throw createAppError('AUTHORIZATION');
}

async function readChunks(
  request: Request,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw createAppError('PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { chunks, length };
}

function combineChunks(chunks: readonly Uint8Array[], length: number) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Bound the stream itself; Content-Length is untrusted and may be absent. */
export async function readJson(
  request: Request,
  maxBytes = 4096,
): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw createAppError('VALIDATION');
  const reader = request.body?.getReader();
  if (!reader) throw createAppError('VALIDATION');
  const { chunks, length } = await readChunks(request, reader, maxBytes);
  const bytes = combineChunks(chunks, length);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw createAppError('VALIDATION');
  }
}

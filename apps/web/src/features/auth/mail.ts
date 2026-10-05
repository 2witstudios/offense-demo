import type { IdGenerator } from '@offense-demo/clock';
import type { AuthEmailMessage, AuthEmailSender } from './mail-types';

const ENDPOINT = 'https://api.resend.com/emails';

/** Outbound HTTP as the transport uses it: a request in, a response out. */
export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Failure carries a status class only: never the body, recipient or link. */
class DeliveryError extends Error {
  constructor(
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super('Email delivery failed');
  }
}

/**
 * Resend transport behind the injected `send` seam. One user-requested link
 * is one operation: a single idempotency key, a total delivery deadline, and
 * at most one retry of a transient failure under that same key. Open/click
 * tracking is a Resend domain setting (documented for AUTH-1.3); the message
 * carries no tracked or third-party links.
 */
export function createResendSender({
  apiKey,
  from,
  ids,
  fetch: fetchImpl = fetch,
  timeoutMs = 10_000,
  elapsed = () => performance.now(),
}: {
  readonly apiKey: string;
  readonly from: string;
  readonly ids: IdGenerator;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly elapsed?: () => number;
}): AuthEmailSender {
  const attempt = async (
    message: AuthEmailMessage,
    idempotencyKey: string,
    budgetMs: number,
  ) => {
    let response: Response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(budgetMs),
      });
    } catch {
      throw new DeliveryError(true);
    }
    if (!response.ok)
      throw new DeliveryError(
        response.status === 429 || response.status >= 500,
        response.status,
      );
    let id: unknown;
    try {
      id = ((await response.json()) as { id?: unknown }).id;
    } catch {
      throw new DeliveryError(false, response.status);
    }
    if (typeof id !== 'string' || id.length === 0)
      throw new DeliveryError(false, response.status);
    return { providerMessageId: id };
  };
  return {
    async send(message) {
      const idempotencyKey = ids.next();
      const started = elapsed();
      const remaining = () => timeoutMs - (elapsed() - started);
      try {
        return await attempt(message, idempotencyKey, timeoutMs);
      } catch (error) {
        if (!(error instanceof DeliveryError) || !error.transient)
          throw new DeliveryError(false, (error as DeliveryError).status);
        const budget = Math.floor(remaining());
        if (budget < 1) throw error;
        return attempt(message, idempotencyKey, budget);
      }
    },
  };
}

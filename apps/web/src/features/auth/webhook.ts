import { Resend } from 'resend';
import type { Clock } from '@offense-demo/clock';
import {
  emailDeliveryStatusRank,
  type EmailDeliveryStatus,
  type EmailSuppressionReason,
} from '@offense-demo/protocol';
import { readBoundedBody } from './bounded-body';

const MAX_BODY_BYTES = 64 * 1024;
/** A just-sent message can be reported before its send is recorded. */
const RACE_WINDOW_MS = 120_000;

type ProviderEvent = {
  readonly type: string;
  readonly created_at?: string;
  readonly data?: {
    readonly email_id?: unknown;
    readonly bounce?: { readonly type?: unknown };
  };
};
type DeliveryEvent = {
  readonly status: EmailDeliveryStatus;
  readonly rank: number;
  readonly suppress: EmailSuppressionReason | null;
  readonly messageId: string;
};
type ApplyInput = Omit<DeliveryEvent, 'messageId'> & {
  readonly eventId: string;
  readonly providerMessageId: string;
  readonly at: string;
};

/**
 * The protocol status each provider event reports; ranks are the protocol's.
 * A Map, not an object literal: a lookup by an attacker-chosen event type
 * must never reach an inherited `Object.prototype` member.
 */
const STATUS_BY_EVENT: ReadonlyMap<string, EmailDeliveryStatus> = new Map<
  string,
  EmailDeliveryStatus
>([
  ['email.sent', 'sent'],
  ['email.delivery_delayed', 'delayed'],
  ['email.delivered', 'delivered'],
  ['email.failed', 'failed'],
  ['email.complained', 'complained'],
]);
/** Only a permanent failure or a complaint stops automatic mail. */
const SUPPRESSION: Partial<
  Record<EmailDeliveryStatus, EmailSuppressionReason>
> = { bounced: 'bounce', complained: 'complaint' };

/**
 * Only safe status is derived: the recipient list and any other payload
 * field is never read. Only permanent bounces and complaints suppress.
 */
export function classifyResendEvent(
  event: ProviderEvent,
): DeliveryEvent | null {
  const messageId = event.data?.email_id;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  // A transient bounce is a delay the provider retries, not a failure.
  const bounce =
    event.data?.bounce?.type === 'Permanent' ? 'bounced' : 'delayed';
  const status =
    event.type === 'email.bounced' ? bounce : STATUS_BY_EVENT.get(event.type);
  if (!status) return null;
  return {
    status,
    rank: emailDeliveryStatusRank(status),
    suppress: SUPPRESSION[status] ?? null,
    messageId,
  };
}

const respond = (status: number, body: unknown, headers?: HeadersInit) =>
  Response.json(body, { status, ...(headers ? { headers } : {}) });
const rejected = () =>
  respond(400, { error: { code: 'VALIDATION', message: 'Invalid input' } });

/**
 * Authenticates provider webhooks over the raw body with the official Resend
 * verifier (five-minute timestamp tolerance), deduplicates by event ID in
 * PostgreSQL and records only safe delivery status. Delivery events never
 * touch users, sessions or verification records: they cannot verify or change
 * ownership.
 */
export function createResendWebhook({
  secret,
  apiKey,
  clock,
  apply,
}: {
  readonly secret: string;
  readonly apiKey: string;
  readonly clock: Clock;
  readonly apply: (
    input: ApplyInput,
  ) => Promise<'applied' | 'duplicate' | 'unknown-message'>;
}) {
  const resend = new Resend(apiKey);
  const verify = async (request: Request) => {
    const id = request.headers.get('svix-id');
    const timestamp = request.headers.get('svix-timestamp');
    const signature = request.headers.get('svix-signature');
    if (!id || !timestamp || !signature) return null;
    const body = await readBoundedBody(request, MAX_BODY_BYTES);
    if (body === null) return null;
    // Signatures cover the exact bytes: verify the raw text, never re-serialized.
    const payload = body.toString('utf8');
    try {
      const event = resend.webhooks.verify({
        payload,
        headers: { id, timestamp, signature },
        webhookSecret: secret,
      }) as unknown as ProviderEvent;
      return { id, event };
    } catch {
      return null;
    }
  };
  /** A racing event is retried by the provider once the send is recorded. */
  const unknownResponse = (event: ProviderEvent, at: string) => {
    const emitted = Date.parse(event.created_at ?? '');
    const recent =
      Number.isFinite(emitted) && Date.parse(at) - emitted < RACE_WINDOW_MS;
    return recent
      ? respond(503, { status: 'retry' }, { 'Retry-After': '5' })
      : respond(200, { status: 'ignored' });
  };
  return {
    async handle(request: Request): Promise<Response> {
      const verified = await verify(request);
      if (!verified) return rejected();
      const delivery = classifyResendEvent(verified.event);
      if (!delivery) return respond(200, { status: 'ignored' });
      const at = clock.now();
      const outcome = await apply({
        eventId: verified.id,
        providerMessageId: delivery.messageId,
        status: delivery.status,
        rank: delivery.rank,
        suppress: delivery.suppress,
        at,
      });
      return outcome === 'unknown-message'
        ? unknownResponse(verified.event, at)
        : respond(200, { status: outcome });
    },
  };
}

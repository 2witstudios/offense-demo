import {
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Attributes,
  type Context,
} from '@opentelemetry/api';

import type { SignalTarget } from './process-lifecycle';
export {
  installForcedShutdown,
  watchParentLiveness,
  type LivenessStdin,
  type SignalTarget,
} from './process-lifecycle';

const traceparentPattern =
  /^(?!ff-)([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

/** W3C trace context must not contain zero trace or parent identifiers. */
export function isValidTraceparent(value: string | null): value is string {
  if (!value) return false;
  const match = traceparentPattern.exec(value);
  const traceId = match?.[2];
  const parentId = match?.[3];
  return Boolean(
    match &&
    traceId &&
    parentId &&
    !/^0+$/.test(traceId) &&
    !/^0+$/.test(parentId) &&
    match[1] !== 'ff',
  );
}

export function extractTraceContext(headers: Headers): Context {
  const traceparent = headers.get('traceparent');
  if (!isValidTraceparent(traceparent)) return ROOT_CONTEXT;
  return propagation.extract(
    ROOT_CONTEXT,
    {
      traceparent,
      tracestate: headers.get('tracestate') ?? undefined,
    },
    {
      keys: (carrier) => Object.keys(carrier),
      get: (carrier, key) => carrier[key as keyof typeof carrier],
    },
  );
}

/** Uses the host's provider; no-op until one is installed by the deployment. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  return trace
    .getTracer('offense-demo')
    .startActiveSpan(name, { attributes }, parent, async (span) => {
      try {
        return await operation();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : undefined;
}
export function requestId(incoming: string | null): string {
  return incoming && /^[a-zA-Z0-9_-]{8,100}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
}
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Operation timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs `close`, force-exiting through `onDeadlineExceeded` if it does not
 * finish within `deadlineMs`; shared by every deployment's SIGTERM drain
 * (`apps/web/src/server/start.ts`, `apps/realtime/src/start.ts`) so a hung
 * close cannot block a restart or deploy forever. Each caller supplies its
 * own close sequence (its listener, app framework, background jobs,
 * connection pools); this owns only the shared deadline race.
 */
export async function drainWithDeadline({
  deadlineMs,
  onDeadlineExceeded,
  close,
}: {
  readonly deadlineMs: number;
  readonly onDeadlineExceeded: () => void;
  readonly close: () => Promise<void>;
}): Promise<void> {
  const deadline = setTimeout(onDeadlineExceeded, deadlineMs);
  deadline.unref();
  await close();
  clearTimeout(deadline);
}

/**
 * A process's shutdown state over the resources it must close (a database
 * pool, a Redis client): readiness reports draining from `drain()` on, and
 * `close()` drains, then closes every resource once without rejecting, so
 * one failed close never leaves another open.
 */
export function createDrainState(
  closers: ReadonlyArray<{ readonly close: () => unknown }>,
) {
  let draining = false;
  return {
    isDraining: () => draining,
    drain: () => {
      draining = true;
    },
    close: async () => {
      draining = true;
      await Promise.allSettled(
        closers.map((closer) => Promise.resolve().then(() => closer.close())),
      );
    },
  };
}

/** Registers `shutdown` once for SIGTERM and SIGINT, exiting on rejection. */
export function installShutdownSignals(
  shutdown: () => Promise<void>,
  target: SignalTarget = process,
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    target.once(signal, () => void shutdown().catch(() => process.exit(1)));
}

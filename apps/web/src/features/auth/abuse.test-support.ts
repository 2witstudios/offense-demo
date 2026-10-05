import { memoryAdapter } from '@better-auth/memory-adapter';
import type { Logger } from '@offense-demo/logger';
import { composeAuthServer, memoryTables } from './auth-server.test-support';
import type { AfterResponseLimits } from './after-response';
import type { AuthEmailMessage } from './server';

/**
 * The four database steps a saturated request's handed-off work makes (the
 * account lookup, the suppression read, the receipt write and the token
 * delete), each made to take `delayMs` and counted while it runs, so a test
 * can see how many run at once (ISSUE-247). `holdNext` keeps the next step
 * of a name from finishing until released. Steps made while a request is being answered
 * (its own suppression check) run too, so peaks are read with `measure`.
 */
const createStepTracker = (delayMs: number) => {
  let active = 0;
  let peak = 0;
  let measuring = false;
  let held:
    { readonly step: string; readonly until: Promise<void> } | undefined;
  const started: string[] = [];
  return {
    track: async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      started.push(name);
      active += 1;
      if (measuring) peak = Math.max(peak, active);
      try {
        if (held?.step === name) {
          const { until } = held;
          held = undefined;
          await until;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await run();
      } finally {
        active -= 1;
      }
    },
    /** Counts the peak from now on. */
    measure: () => {
      measuring = true;
      peak = active;
    },
    peak: () => peak,
    started: (): readonly string[] => started,
    /** Holds the next `step` until the returned release is called. */
    holdNext: (step: string) => {
      let release = () => {};
      held = {
        step,
        until: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return release;
    },
  };
};

type StepTracker = ReturnType<typeof createStepTracker>;

/** The memory adapter with the account lookup and token delete tracked. */
const trackedAdapter = (
  base: ReturnType<typeof memoryAdapter>,
  tracker: StepTracker | undefined,
): ReturnType<typeof memoryAdapter> => {
  if (!tracker) return base;
  const steps: Record<string, string> = {
    'findOne:user': 'lookup',
    'delete:verification': 'token delete',
    'deleteMany:verification': 'token delete',
  };
  return ((...args: Parameters<typeof base>) => {
    const adapter = base(...args);
    return new Proxy(adapter, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (query: { model?: string }, ...rest: unknown[]) => {
          const step = steps[`${String(property)}:${query?.model}`];
          const call = () =>
            Promise.resolve(value.call(target, query, ...rest));
          return step ? tracker.track(step, call) : call();
        };
      },
    });
  }) as ReturnType<typeof memoryAdapter>;
};

export type Consumed = {
  key: string;
  rule: { windowSeconds: number; max: number };
};
export const create = (
  options: {
    suppressed?: boolean;
    ledgerFailure?: boolean;
    recordFailure?: boolean;
    /** The mail transport rejects every send (a provider outage). */
    sendFailure?: boolean;
    /** The mail transport answers nothing until `release()` is called. */
    heldTransport?: boolean;
    /** Slows and counts the handed-off database steps (`createStepTracker`). */
    stepDelayMs?: number;
    afterResponseLimits?: AfterResponseLimits;
    limiter?: (consumed: Consumed[]) => (
      key: string,
      rule: Consumed['rule'],
    ) => Promise<{
      allowed: boolean;
      retryAfterSeconds: number;
    }>;
  } = {},
) => {
  const db = memoryTables();
  const steps =
    options.stepDelayMs === undefined
      ? undefined
      : createStepTracker(options.stepDelayMs);
  const tracked = <T>(name: string, run: () => Promise<T>) =>
    steps ? steps.track(name, run) : run();
  const consumed: Consumed[] = [];
  const lookups = { count: 0 };
  const sent: AuthEmailMessage[] = [];
  const logs: unknown[][] = [];
  const logger: Logger = {
    log: (...entry) => void logs.push(entry),
    child: () => logger,
  };
  const recorded: Array<{ providerMessageId: string; recipientHash: string }> =
    [];
  /** Every seam call in order: each limiter key, suppression, send, record. */
  const trace: string[] = [];
  let release = () => {};
  const held = options.heldTransport
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : undefined;
  let reached = () => {};
  /** Resolves when the transport is first asked to send. */
  const transportReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const limit = options.limiter
    ? options.limiter(consumed)
    : async (key: string, rule: Consumed['rule']) => {
        consumed.push({ key, rule });
        return { allowed: true, retryAfterSeconds: 0 };
      };
  const server = composeAuthServer({
    database: trackedAdapter(memoryAdapter(db), steps),
    ...(options.afterResponseLimits
      ? { afterResponseLimits: options.afterResponseLimits }
      : {}),
    emailSender: {
      send: async (message) => {
        trace.push('send');
        reached();
        await held;
        if (options.sendFailure) throw new Error('transport down');
        sent.push(message);
        return { providerMessageId: `msg_${sent.length}` };
      },
    },
    limiter: {
      consume: (key, rule) => {
        trace.push(key);
        return limit(key, rule);
      },
    },
    ledger: {
      isSuppressed: () =>
        tracked('suppression read', async () => {
          trace.push('suppression');
          lookups.count += 1;
          if (options.ledgerFailure) throw new Error('ledger down');
          return options.suppressed ?? false;
        }),
      record: (input) =>
        tracked('receipt write', async () => {
          trace.push('record');
          if (options.recordFailure) throw new Error('record down');
          recorded.push(input);
        }),
    },
    logger,
  });
  return {
    server,
    db,
    consumed,
    sent,
    recorded,
    lookups,
    logs,
    trace,
    transportReached,
    release: () => release(),
    steps,
  };
};
/** Everything a caller observes of an answer: status, body and every header. */
export const observableAnswer = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
  headers: [...response.headers.entries()],
});
export const tokenIn = (message: AuthEmailMessage | undefined) =>
  new URL(
    message?.text.match(/https?:\/\/\S+/)?.[0] ?? 'http://x.invalid',
  ).searchParams.get('token') ?? '';
export const magicLinkRequest = (
  headers: Record<string, string> = {},
  email = 'player@offense-demo.example.com',
) =>
  new Request('http://localhost:3000/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...headers,
    },
    body: JSON.stringify({ email }),
  });

/** An account holding the address `magicLinkRequest` asks for. */
export const existingAccount = {
  id: 'user-1',
  email: 'player@offense-demo.example.com',
  emailVerified: true,
  name: '',
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  updatedAt: new Date('2026-09-20T00:00:00.000Z'),
};

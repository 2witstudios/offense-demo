import { dispatchDocumentationEvent } from './docs-consult';
import type { ConsultOptions } from './docs-consult-options';
import { createDocumentationEvent } from './docs-pipeline';

// Shared fixtures for the docs-consult suites.

export const CUID2 = /^[a-z][a-z0-9]{1,31}$/;

export const mergeEvent = (
  title = 'feat(protocol): add the tournament envelope',
) =>
  createDocumentationEvent({
    eventId: '1001-merge007',
    eventType: 'pull_request.merged',
    occurredAt: '2026-09-20T00:00:00.000Z',
    repository: '2witstudios/offense-demo',
    baseRef: 'main',
    commit: 'merge007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pullRequest: {
      number: 7,
      title,
      body: null,
      url: 'https://github.com/2witstudios/offense-demo/pull/7',
      author: '2witstudios',
      mergedBy: '2witstudios',
    },
    taskIds: [],
    changedFiles: ['packages/protocol/src/events.ts'],
  });

type Captured = {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
};

export const hangUntilAborted = (init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

// Answers after `ms`, unless the request's signal aborts it first.
const answerAfter = (
  answer: Response,
  ms: number | undefined,
  init?: RequestInit,
): Promise<Response> =>
  !ms
    ? Promise.resolve(answer)
    : new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        setTimeout(() => resolve(answer), ms);
      });

// The consult route's own failure: it answers only after its run has ended.
export const routeFailure = (status = 500) =>
  Response.json(
    { error: 'Failed to generate response from agent: provider unavailable' },
    { status },
  );

// A response whose status arrived but whose body is lost on the way back.
export const droppedBody = (status: number) =>
  new Response(
    new ReadableStream({
      start: (controller) => controller.error(new TypeError('body dropped')),
    }),
    { status },
  );

type Stub = {
  readonly consult: (init?: RequestInit) => Promise<Response>;
  /** The conversation's roles once its consult has been sent. */
  readonly roles?: () => readonly string[];
  /** The conversation's roles before any consult: a pre-existing run. */
  readonly existing?: readonly string[];
  /** Where the Runs sheet appends the reserved receipt row (0-based). */
  readonly firstRowIndex?: number;
  /** Replaces the append response body, to model a malformed answer. */
  readonly appendBody?: unknown;
  /** Endpoints that accept the request and never answer until aborted. */
  readonly hang?: readonly ('reads' | 'append')[];
  /** Conversation reads answer after this long (still abortable). */
  readonly readDelayMs?: number;
  /** The receipt-row append answers after this long (still abortable). */
  readonly appendDelayMs?: number;
  /** Conversation reads after the consult fail with this status, or with
   * the status returned for the nth such read (1-based; none = succeed). */
  readonly readStatus?: number | ((read: number) => number | undefined);
};

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

// Serves every endpoint dispatch touches, tracking each conversation by id:
// the pre-check read before a consult, the Runs-sheet append that reserves
// the receipt row, the consult itself, and the settlement reads after it.
// `counts.messages` counts only reads after a conversation's consult.
export const routedFetch = (stub: Stub) => {
  const counts = { consult: 0, messages: 0, appends: 0 };
  const consults: Captured[] = [];
  const appended: Record<string, string>[] = [];
  const consulted = new Set<string>();
  const consult = (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    counts.consult += 1;
    consults.push({ url, init: init ?? {}, body });
    consulted.add(String(body.newConversationId));
    return stub.consult(init);
  };
  const append = (init?: RequestInit) => {
    const { rows } = JSON.parse(String(init?.body)) as {
      rows: Record<string, string>[];
    };
    counts.appends += 1;
    appended.push(...rows);
    if (stub.hang?.includes('append')) return hangUntilAborted(init);
    const index = stub.firstRowIndex ?? 1;
    const answer = json(
      stub.appendBody ?? { firstRowIndex: index, appended: 1 },
    );
    return answerAfter(answer, stub.appendDelayMs, init);
  };
  const read = (path: string, init?: RequestInit) => {
    if (stub.hang?.includes('reads')) return hangUntilAborted(init);
    const sent = consulted.has(path.split('/').at(-2) ?? '');
    if (sent) counts.messages += 1;
    const failWith =
      typeof stub.readStatus === 'function'
        ? stub.readStatus(counts.messages)
        : stub.readStatus;
    if (sent && failWith) return new Response('', { status: failWith });
    const roles = sent ? (stub.roles?.() ?? []) : (stub.existing ?? []);
    const answer = json({ messages: roles.map((role) => ({ role })) });
    return answerAfter(answer, stub.readDelayMs, init);
  };
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/ai/page-agents/consult')
      return consult(String(url), init);
    if (path === '/api/mcp/sheets') return append(init);
    return read(path, init);
  }) as unknown as typeof fetch;
  return { counts, consults, appended, fetchImpl };
};

// Records only the consult calls; every other endpoint answers as a fresh run.
export const recordingFetch = (
  respond: (body: Record<string, unknown>) => Response,
) => {
  const { consults, fetchImpl } = routedFetch({
    consult: async (init) =>
      respond(JSON.parse(String(init?.body)) as Record<string, unknown>),
  });
  return { calls: consults, fetchImpl };
};

export const ok = () =>
  new Response(JSON.stringify({ success: true }), { status: 200 });

/** A fake drive layout; real ids come from project.config.json. */
export const drive = {
  driveId: 'drive1',
  rootPageId: 'docs-root',
  agentPageId: 'docs-agent',
  runsSheetId: 'runs-sheet',
  targetPages: { 'technical-docs': 'technical-page' },
} as const;

export const baseOptions = {
  token: 'tok',
  apiUrl: 'https://pagespace.test',
  agentId: 'agent1',
  drive,
} as const;

export const instant = { delay: async () => {}, pollIntervalMs: 0 } as const;

// The message a dispatch fails with, or 'no throw' when it succeeds.
export const failureOf = async (dispatch: Promise<unknown>) => {
  try {
    await dispatch;
    return 'no throw';
  } catch (error) {
    return (error as Error).message;
  }
};

/**
 * The message a technical-docs dispatch through `fetchImpl` fails with (or
 * 'no throw'), polling instantly; `options` override anything else.
 */
export const technicalDispatchFailure = (
  fetchImpl: typeof fetch,
  options: ConsultOptions = {},
) =>
  failureOf(
    dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
      ...baseOptions,
      ...instant,
      fetchImpl,
      ...options,
    }),
  );

import {
  type ConsultOptions,
  replayAttempt,
  replayPipelines,
  resolveOptions,
} from './docs-consult-options';
import {
  composeConsultQuestion,
  type ConsultOutcome,
  conversationIdFor,
  describeOutcomes,
  trustedKeys,
} from './docs-consult-question';
import type { DocumentationEvent, DocumentPipeline } from './docs-pipeline';
import { encodeRunRecord } from './docs-runs-sheet';
import { pagespaceApi } from './pagespace-docs';

export function classifyConsultResponse(
  pipeline: DocumentPipeline,
  status: number,
  rawBody: string,
): ConsultOutcome['outcome'] {
  if (status >= 200 && status < 300) return 'dispatched';
  if (status === 409) return 'already-dispatched';
  throw new Error(`${consultFor(pipeline)} responded ${status}: ${rawBody}`);
}

// The consult route reports its own failure as a JSON { error } body, and it
// answers only once its run has ended, so that failure is final. A gateway's
// 5xx (Caddy's empty 502, an HTML error page) is not: it can front a run that
// is still going. Returns the route's message, or undefined for anything else.
function routeFailure(response: Response, body: string): string | undefined {
  if (response.status < 500) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return undefined;
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

// Runtimes differ on how an expired signal surfaces: AbortError or TimeoutError.
const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Every dispatch failure opens with its pipeline and ends with its replay.
const consultFor = (pipeline: DocumentPipeline): string =>
  `Documentation Agent consult for ${pipeline}`;
const replayWith = (pipeline: DocumentPipeline, attempt: number): string =>
  `DOC_REPLAY_ATTEMPT=${attempt} DOC_PIPELINES=${pipeline}`;

type ConversationState = 'answered' | 'pending' | 'absent' | 'unreadable';

// One consult per routed pipeline, one at a time, each its own conversation
// and receipt,
// matching the (sourceSnapshot, workflow) key docs-reconcile checks. A consult
// is non-idempotent and is never retried here: a retry would run the agent
// twice. Re-running the workflow is the retry, and the derived id makes it
// safe; DOC_REPLAY_ATTEMPT reaches a run that was cut off, and DOC_PIPELINES
// limits a replay to the pipelines that need it.
export async function dispatchDocumentationEvent(
  event: DocumentationEvent,
  options: ConsultOptions = {},
): Promise<readonly ConsultOutcome[]> {
  const { apiUrl, headers } = pagespaceApi(options);
  const endpoint = new URL('/api/ai/page-agents/consult', apiUrl).toString();
  const {
    drive,
    agentId,
    fetchImpl,
    nonce,
    timeoutMs,
    budgetEnd,
    pollIntervalMs,
    requestTimeoutMs,
    delay,
    now,
  } = resolveOptions(options);
  const attempt = replayAttempt(options.attempt);
  const pipelines = replayPipelines(
    options.pipelines,
    event.classification.pipelines,
  );

  // Every PageSpace request is bounded, not only the consult: a call PageSpace
  // accepts and never answers must not outlive the budget, or the CI job is
  // cancelled before its incidents step runs.
  const until = (end: number, cap = Number.POSITIVE_INFINITY): AbortSignal =>
    AbortSignal.timeout(Math.max(1, Math.min(cap, end - now())));

  // 'absent' is a successful read that found no conversation; 'unreadable' is
  // a read that failed, which proves nothing either way.
  const readConversation = async (
    conversationId: string,
    end: number,
  ): Promise<ConversationState> => {
    try {
      const response = await fetchImpl(
        new URL(
          `/api/ai/page-agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`,
          apiUrl,
        ).toString(),
        {
          method: 'GET',
          redirect: 'error',
          headers,
          signal: until(end, requestTimeoutMs),
        },
      );
      if (!response.ok) return 'unreadable';
      const { messages } = (await response.json()) as {
        messages?: readonly { role?: string }[];
      };
      if (!messages || messages.length === 0) return 'absent';
      return messages.some((message) => message.role === 'assistant')
        ? 'answered'
        : 'pending';
    } catch {
      return 'unreadable';
    }
  };

  // Two successful reads that find no conversation end the wait as 'absent'
  // (the first is a grace read), as does one at the deadline. A failed
  // read proves nothing either way, so polling goes on to the deadline and
  // reports 'unreadable' only then, when the full wait has really passed.
  // Polling stops at the consult's deadline, but each read is bounded by the
  // budget, so the read after a consult times out still has time to answer.
  const awaitAnswer = async (
    conversationId: string,
    deadline: number,
  ): Promise<ConversationState> => {
    let seenQuestion = false;
    let emptyReads = 0;
    for (;;) {
      const state = await readConversation(conversationId, budgetEnd);
      if (state === 'answered') return 'answered';
      if (state === 'pending') seenQuestion = true;
      if (state === 'absent') emptyReads += 1;
      if (!seenQuestion && emptyReads >= 2) return 'absent';
      if (now() >= deadline) return seenQuestion ? 'pending' : state;
      // Never sleep past the deadline: the next read, bounded by the budget,
      // then still ends inside it.
      await delay(Math.min(pollIntervalMs, deadline - now()));
    }
  };

  // Appends this run's receipt before the consult, holding every trusted key
  // and marked failed until the agent rewrites it. PageSpace locks the tab for
  // an append, so concurrent runs never claim the same row, which a run left to
  // find an empty row for itself would race other runs for.
  const reserveRunRow = async (
    pipeline: DocumentPipeline,
    conversationId: string,
  ): Promise<number> => {
    const startedAt = new Date().toISOString();
    const response = await fetchImpl(
      new URL('/api/mcp/sheets', apiUrl).toString(),
      {
        method: 'POST',
        redirect: 'error',
        headers,
        signal: until(budgetEnd, requestTimeoutMs),
        body: JSON.stringify({
          operation: 'append-rows',
          pageId: drive.runsSheetId,
          rows: [
            encodeRunRecord({
              ...trustedKeys(event, pipeline, conversationId),
              startedAt,
              completedAt: startedAt,
              status: 'failed',
              scope: { pageIds: [], changedSince: event.occurredAt },
              pagesReviewed: 0,
              findings: [],
              autoFixed: 0,
              tasksCreated: 0,
              pagesInvalidated: 0,
              notes:
                'Dispatched; the Documentation Agent has not recorded its result yet.',
            }),
          ],
        }),
      },
    );
    const body = await response.text();
    if (!response.ok)
      throw new Error(
        `Reserving the ${pipeline} run record responded ${response.status}: ${body}`,
      );
    // The index names the row the agent will rewrite: anything but a
    // non-negative integer would point it at another run's receipt.
    let firstRowIndex: unknown;
    try {
      firstRowIndex = (JSON.parse(body) as { firstRowIndex?: unknown })
        .firstRowIndex;
    } catch {
      firstRowIndex = undefined;
    }
    if (!Number.isInteger(firstRowIndex) || (firstRowIndex as number) < 0)
      throw new Error(
        `Reserving the ${pipeline} run record returned no usable row index: ${body}`,
      );
    return (firstRowIndex as number) + 1;
  };

  // Sends the consult and reads its whole answer. A connection dropped
  // before the status arrived is settled by the conversation. Once a status
  // below 500 has arrived it is definitive on its own, so a body lost after it
  // is ignored; a 5xx whose body is lost is settled like a dropped connection.
  const send = async (
    question: string,
    conversationId: string,
    deadline: number,
    waitSeconds: number,
  ): Promise<{ response: Response; body: string } | { cause: string }> => {
    const causeOf = (error: unknown) =>
      isAbort(error) ? `no answer within ${waitSeconds}s` : messageOf(error);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: until(deadline),
        headers,
        body: JSON.stringify({
          agentId,
          question,
          newConversationId: conversationId,
        }),
      });
    } catch (error) {
      return { cause: causeOf(error) };
    }
    try {
      return { response, body: await response.text() };
    } catch (error) {
      return response.status < 500
        ? { response, body: `(body lost: ${causeOf(error)})` }
        : {
            cause: `responded ${response.status}; body lost: ${causeOf(error)}`,
          };
    }
  };

  const consult = async (
    pipeline: DocumentPipeline,
  ): Promise<ConsultOutcome> => {
    const conversationId = conversationIdFor(
      event.idempotencyKey,
      pipeline,
      attempt,
    );
    // A conversation that already exists was dispatched before (a re-run of
    // the workflow): report it without reserving a row or running the agent.
    // A lookup that fails (unreadable) or finds nothing falls through to the
    // consult, so a transient failure (or a race between identical
    // dispatches) can still reach it; PageSpace then refuses the id with 409
    // and the extra reserved row stays failed, which the reconciler never
    // counts as a receipt.
    const existing = await readConversation(conversationId, budgetEnd);
    if (existing === 'answered' || existing === 'pending')
      return { pipeline, conversationId, outcome: 'already-dispatched' };
    // A failed reservation sent nothing, so the same attempt replays it; an
    // append that landed before its answer was lost leaves a failed row the
    // reconciler never counts.
    const runRow = await reserveRunRow(pipeline, conversationId).catch(
      (error: unknown) => {
        throw new Error(
          `${consultFor(pipeline)} was not sent: reserving its receipt failed (${messageOf(error)}). Any row it did reserve stays failed; replay with ${replayWith(pipeline, attempt)}`,
          { cause: error },
        );
      },
    );
    const receipt = `row ${runRow} of Documentation Runs`;
    // The consult stops one request-timeout before the budget, reserving a
    // window to read the conversation afterwards: a read given only what was
    // left of the deadline would report a slow run as never having arrived.
    const deadline = Math.min(now() + timeoutMs, budgetEnd - requestTimeoutMs);
    // The pre-check and the reservation spend time of their own, so the
    // window is checked again here: a question sent with none left would be
    // abandoned at once. Nothing was sent, so the same id replays it.
    if (deadline <= now())
      throw new Error(
        `${consultFor(pipeline)} was not sent: the dispatch budget ran out after reserving its receipt, ${receipt}, which stays failed; replay with ${replayWith(pipeline, attempt)}`,
      );
    const waitSeconds = Math.round((deadline - now()) / 1000);
    const replay = replayWith(pipeline, attempt + 1);
    // Nothing tells a live run from a dead one, and a live run's row stays
    // failed until it ends. PageSpace caps a consult run at 20 tool steps and
    // the longest seen took about 25 minutes, so an hour bounds the wait: a
    // replay held until the conversation answers or that hour passes can
    // neither run beside a live run nor strand a dead one.
    const lateReplay = `replay with ${replay} once conversation ${conversationId} has an answer or an hour after this failure, whichever comes first; replaying sooner can start a second run beside a live one`;
    const answered = {
      pipeline,
      conversationId,
      outcome: 'dispatched',
    } as const;
    const settle = async (cause: string): Promise<ConsultOutcome> => {
      const state = await awaitAnswer(conversationId, deadline);
      if (state === 'answered') return answered;
      // Two successful empty reads mean the id was almost certainly never
      // used, so the same attempt replays it. PageSpace claims the id before
      // it saves the question, though, so a 409 on that replay proves only
      // that the conversation exists; the message says what to do then.
      if (state === 'absent')
        throw new Error(
          `${consultFor(pipeline)} never reached PageSpace (${cause}). Its receipt, ${receipt}, stays failed unless the request lands late; replay with ${replayWith(pipeline, attempt)}. If that replay reports already-dispatched while bun docs:reconcile still lists it, the request landed late: ${lateReplay}`,
        );
      throw new Error(
        `${consultFor(pipeline)} did not answer within ${waitSeconds}s (${cause}). The run may still be going: its receipt is ${receipt}. If the row is no longer failed (complete or partial), nothing is lost. Otherwise ${lateReplay}`,
      );
    };
    const sent = await send(
      composeConsultQuestion({
        event,
        pipeline,
        conversationId,
        runRow,
        nonce: nonce(),
        drive,
      }),
      conversationId,
      deadline,
      waitSeconds,
    );
    if ('cause' in sent) return settle(sent.cause);
    const { response, body } = sent;
    // The route answers only once it has stopped, so its own failure is
    // final: a read finds an answer saved before the failure, and polling for
    // more would only spend the deadline other pipelines need. An empty or
    // unreadable conversation may be a blip, so it earns one more read.
    const reported = routeFailure(response, body);
    if (reported !== undefined) {
      let state = await readConversation(conversationId, budgetEnd);
      if (state === 'absent' || state === 'unreadable') {
        await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
        state = await readConversation(conversationId, budgetEnd);
      }
      if (state === 'answered') return answered;
      throw new Error(
        `${consultFor(pipeline)} failed in PageSpace (responded ${response.status}: ${reported}) and ${state === 'unreadable' ? 'its conversation could not be read' : 'its conversation holds no answer'}. The run may have recorded its receipt before failing: if ${receipt} is no longer failed (complete or partial), nothing is lost; otherwise replay with ${replay}`,
      );
    }
    // Any other 5xx can come from a gateway in front of a run that is still
    // going: a live 502 arrived after 36s with the question already
    // persisted. So it is settled like a dropped connection; a 4xx refusal is
    // definitive, and it comes before any run starts, so once its cause is
    // fixed the same attempt replays it.
    if (response.status >= 500)
      return settle(`responded ${response.status}${body ? `: ${body}` : ''}`);
    try {
      return {
        pipeline,
        conversationId,
        outcome: classifyConsultResponse(pipeline, response.status, body),
      };
    } catch (error) {
      throw new Error(
        `${messageOf(error)}. PageSpace refused it before any run started, and its receipt, ${receipt}, stays failed: fix the cause (token, rate limit, input), then replay with ${replayWith(pipeline, attempt)}`,
        { cause: error },
      );
    }
  };

  const outcomes: ConsultOutcome[] = [];
  const failures: string[] = [];
  for (const pipeline of pipelines) {
    // Start a consult only while it would get time of its own beyond the
    // settlement window; otherwise the question would be sent and abandoned.
    if (now() >= budgetEnd - requestTimeoutMs) {
      failures.push(
        `${consultFor(pipeline)} was not sent: the dispatch budget ran out and no row was reserved; replay with ${replayWith(pipeline, attempt)}`,
      );
      continue;
    }
    try {
      outcomes.push(await consult(pipeline));
    } catch (error) {
      failures.push(messageOf(error));
    }
  }
  // The pipelines that did settle are reported too: without them an
  // already-dispatched pipeline beside a failure would go unmentioned.
  if (failures.length > 0)
    throw new Error(
      [
        ...failures,
        ...(outcomes.length > 0
          ? [`Other pipelines: ${describeOutcomes(outcomes)}`]
          : []),
      ].join('\n'),
    );
  return outcomes;
}

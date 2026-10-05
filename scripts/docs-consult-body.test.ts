import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import { dispatchDocumentationEvent } from './docs-consult';
import { conversationIdFor } from './docs-consult-question';
import {
  baseOptions,
  droppedBody,
  failureOf,
  instant,
  mergeEvent,
  routedFetch,
} from './docs-consult.test-support';

setupRitewayBun();

// The advice every late-landing outcome ends with, for attempt 0's event.
const lateReplay = `replay with DOC_REPLAY_ATTEMPT=1 DOC_PIPELINES=technical-docs once conversation ${conversationIdFor(
  mergeEvent('fix: only technical').idempotencyKey,
  'technical-docs',
  0,
)} has an answer or an hour after this failure, whichever comes first; replaying sooner can start a second run beside a live one`;

// A consult whose status arrived but whose body was lost on the way back.
const dispatchDropped = (status: number, roles: readonly string[]) => {
  const { fetchImpl, counts } = routedFetch({
    consult: async () => droppedBody(status),
    roles: () => roles,
  });
  return {
    counts,
    run: dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
      ...baseOptions,
      ...instant,
      fetchImpl,
    }),
  };
};

describe('dispatchDocumentationEvent with a lost response body', async () => {
  test('settles a lost 5xx body by reading the conversation', async () => {
    const outcomes = await dispatchDropped(502, ['user', 'assistant']).run;
    assert({
      given: 'a 502 whose body read fails and an answered conversation',
      should: 'settle it by the conversation instead of escaping as a throw',
      actual: outcomes.map((outcome) => outcome.outcome),
      expected: ['dispatched'],
    });
  });

  test('names a lost 5xx body as the cause when nothing arrived', async () => {
    const message = await failureOf(dispatchDropped(502, []).run);
    assert({
      given: 'a lost 502 body and a conversation that never appears',
      should: 'fail as never reached, naming the body failure and the replay',
      actual: message,
      expected: `Documentation Agent consult for technical-docs never reached PageSpace (responded 502; body lost: body dropped). Its receipt, row 2 of Documentation Runs, stays failed unless the request lands late; replay with DOC_REPLAY_ATTEMPT=0 DOC_PIPELINES=technical-docs. If that replay reports already-dispatched while bun docs:reconcile still lists it, the request landed late: ${lateReplay}`,
    });
  });

  test('keeps a 409 already-dispatched when its body is lost', async () => {
    const { run, counts } = dispatchDropped(409, []);
    const outcomes = await run;
    assert({
      given: 'a 409 refusal whose body read fails',
      should: 'classify it from the status without polling the conversation',
      actual: {
        outcomes: outcomes.map((outcome) => outcome.outcome),
        reads: counts.messages,
      },
      expected: { outcomes: ['already-dispatched'], reads: 0 },
    });
  });

  test('keeps a 2xx dispatched when its body is lost', async () => {
    const { run, counts } = dispatchDropped(200, []);
    const outcomes = await run;
    assert({
      given: 'a 200 whose body read fails',
      should: 'report dispatched from the status without polling',
      actual: {
        outcomes: outcomes.map((outcome) => outcome.outcome),
        reads: counts.messages,
      },
      expected: { outcomes: ['dispatched'], reads: 0 },
    });
  });

  test('refuses a 4xx whose body is lost', async () => {
    const message = await failureOf(dispatchDropped(403, []).run);
    assert({
      given: 'a 403 refusal whose body read fails',
      should: 'fail naming the status and the lost body, not as never reached',
      actual: message,
      expected:
        'Documentation Agent consult for technical-docs responded 403: (body lost: body dropped). PageSpace refused it before any run started, and its receipt, row 2 of Documentation Runs, stays failed: fix the cause (token, rate limit, input), then replay with DOC_REPLAY_ATTEMPT=0 DOC_PIPELINES=technical-docs',
    });
  });

  test('does not call an unreadable conversation never reached', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: async () => new Response('', { status: 502 }),
      readStatus: 503,
    });
    const message = await failureOf(
      dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        ...instant,
        timeoutMs: 50,
        fetchImpl,
      }),
    );
    assert({
      given: 'a gateway 502 and conversation reads that keep failing',
      should:
        'keep polling to the deadline, then report an unknown outcome with the next attempt',
      actual: {
        neverReached: message.includes('never reached PageSpace'),
        nextAttempt: message.includes('DOC_REPLAY_ATTEMPT=1 '),
        keptPolling: counts.messages > 2,
      },
      expected: { neverReached: false, nextAttempt: true, keptPolling: true },
    });
  });

  test('does not let a failed read spend the grace read', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: async () => new Response('', { status: 502 }),
      readStatus: (read) => (read === 1 ? 503 : undefined),
      roles: () => [],
    });
    const message = await failureOf(
      dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        ...instant,
        fetchImpl,
      }),
    );
    assert({
      given: 'a first conversation read that fails, then empty reads',
      should: 'need two successful empty reads before calling it never reached',
      actual: {
        reads: counts.messages,
        neverReached: message.includes('never reached PageSpace'),
      },
      expected: { reads: 3, neverReached: true },
    });
  });

  test('names the conversation that shows whether a late run ended', async () => {
    const event = mergeEvent('fix: only technical');
    const { fetchImpl } = routedFetch({
      consult: async () => new Response('', { status: 502 }),
      roles: () => ['user'],
    });
    const message = await failureOf(
      dispatchDocumentationEvent(event, {
        ...baseOptions,
        ...instant,
        timeoutMs: 50,
        fetchImpl,
      }),
    );
    const conversation = conversationIdFor(
      event.idempotencyKey,
      'technical-docs',
      0,
    );
    assert({
      given: 'a run still unanswered at the deadline',
      should:
        'name its conversation and hold the replay until it answers or an hour has passed',
      actual: {
        conversation: message.includes(`conversation ${conversation}`),
        holdOff: message.endsWith(
          `the row is no longer failed (complete or partial), nothing is lost. Otherwise ${lateReplay}`,
        ),
      },
      expected: { conversation: true, holdOff: true },
    });
  });
});

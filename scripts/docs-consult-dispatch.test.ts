import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import { dispatchDocumentationEvent } from './docs-consult';
import { conversationIdFor } from './docs-consult-question';
import {
  baseOptions,
  hangUntilAborted,
  instant,
  mergeEvent,
  ok,
  recordingFetch,
  routedFetch,
  technicalDispatchFailure,
} from './docs-consult.test-support';

setupRitewayBun();

describe('dispatchDocumentationEvent', async () => {
  test('consults the agent once per routed pipeline with a bearer token', async () => {
    const { calls, fetchImpl } = recordingFetch(ok);
    const outcomes = await dispatchDocumentationEvent(mergeEvent(), {
      ...baseOptions,
      fetchImpl,
      nonce: () => 'n0nce',
    });
    assert({
      given: 'a merge routed to technical-docs and user-docs',
      should:
        'POST one consult per pipeline to the consult route, authenticated',
      actual: {
        urls: calls.map((call) => call.url),
        auth: calls.map((call) =>
          new Headers(call.init.headers).get('Authorization'),
        ),
        agents: calls.map((call) => call.body.agentId),
        pipelines: outcomes.map((outcome) => outcome.pipeline).sort(),
      },
      expected: {
        urls: [
          'https://pagespace.test/api/ai/page-agents/consult',
          'https://pagespace.test/api/ai/page-agents/consult',
        ],
        auth: ['Bearer tok', 'Bearer tok'],
        agents: ['agent1', 'agent1'],
        pipelines: ['technical-docs', 'user-docs'],
      },
    });
  });

  test('never uses the unframed context field', async () => {
    const { calls, fetchImpl } = recordingFetch(ok);
    await dispatchDocumentationEvent(mergeEvent(), {
      ...baseOptions,
      fetchImpl,
    });
    assert({
      given: 'the consult route prepends context to the question unframed',
      should: 'send the event only inside the fenced question',
      actual: calls.some((call) => 'context' in call.body),
      expected: false,
    });
  });

  test('sends the derived conversation id so replays collide', async () => {
    const event = mergeEvent();
    const { calls, fetchImpl } = recordingFetch(ok);
    await dispatchDocumentationEvent(event, {
      ...baseOptions,
      fetchImpl,
    });
    assert({
      given: 'a dispatch',
      should: 'address each consult by its deterministic conversation id',
      actual: calls.map((call) => call.body.newConversationId).sort(),
      expected: [
        conversationIdFor(event.idempotencyKey, 'technical-docs'),
        conversationIdFor(event.idempotencyKey, 'user-docs'),
      ].sort(),
    });
  });

  test('does not retry a non-idempotent consult', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: async () => new Response('busy', { status: 503 }),
      roles: () => [],
    });
    let threw = false;
    try {
      await dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        ...instant,
        fetchImpl,
      });
    } catch {
      threw = true;
    }
    assert({
      given: 'a 503 on a merge routed to one pipeline',
      should: 'send exactly one consult rather than double-running the agent',
      actual: { consults: counts.consult, threw },
      expected: { consults: 1, threw: true },
    });
  });

  test('consults pipelines one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetchImpl } = routedFetch({
      consult: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // One full event-loop turn: long enough for a concurrent consult
        // to start, with no wall-clock wait.
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return new Response('{}', { status: 200 });
      },
      roles: () => [],
    });
    const outcomes = await dispatchDocumentationEvent(mergeEvent(), {
      ...baseOptions,
      fetchImpl,
    });
    assert({
      given: 'a merge routed to two pipelines',
      should:
        'never run two consults at once, since concurrent consults were cut off',
      actual: {
        peak,
        outcomes: outcomes.map(
          ({ pipeline, outcome }) => `${pipeline}:${outcome}`,
        ),
      },
      expected: {
        peak: 1,
        outcomes: ['technical-docs:dispatched', 'user-docs:dispatched'],
      },
    });
  });

  test('ends the budget no later than the job-anchored deadline', async () => {
    const { counts, fetchImpl } = routedFetch({ consult: async () => ok() });
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        fetchImpl,
        budgetEndsAt: Date.now() - 1,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a CI job whose share of time is already spent before dispatch',
      should: 'send nothing, leaving the job time to report the incident',
      actual: {
        consults: counts.consult,
        unsent: message.includes(
          'technical-docs was not sent: the dispatch budget ran out',
        ),
      },
      expected: { consults: 0, unsent: true },
    });
  });

  test('refuses a malformed job deadline instead of ignoring it', async () => {
    const previous = process.env.DOC_BUDGET_ENDS_AT;
    process.env.DOC_BUDGET_ENDS_AT = 'soon';
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        fetchImpl: routedFetch({ consult: async () => ok() }).fetchImpl,
      });
    } catch (error) {
      message = (error as Error).message;
    } finally {
      if (previous === undefined) delete process.env.DOC_BUDGET_ENDS_AT;
      else process.env.DOC_BUDGET_ENDS_AT = previous;
    }
    assert({
      given: 'DOC_BUDGET_ENDS_AT that is not epoch seconds',
      should:
        'throw, since an unusable deadline would silently drop the safety margin',
      actual: message,
      expected: 'DOC_BUDGET_ENDS_AT must be a positive integer (epoch seconds)',
    });
  });

  test('still consults the remaining pipelines after one fails', async () => {
    let calls = 0;
    const { counts, fetchImpl } = routedFetch({
      consult: async () =>
        ++calls === 1
          ? new Response('{"error":"forbidden"}', { status: 403 })
          : new Response('{}', { status: 200 }),
      roles: () => [],
    });
    const event = mergeEvent();
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(event, {
        ...baseOptions,
        fetchImpl,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    const [failed = '', others = ''] = message.split('\nOther pipelines: ');
    assert({
      given: 'a refusal for the first of two pipelines',
      should:
        'send the second anyway, then fail naming the refused one and still report the second',
      actual: {
        consults: counts.consult,
        namesRefused: failed.includes('technical-docs responded 403'),
        blamesSecond: failed.includes('user-docs'),
        reportsSecond: others,
      },
      expected: {
        consults: 2,
        namesRefused: true,
        blamesSecond: false,
        reportsSecond: `user-docs → ${conversationIdFor(event.idempotencyKey, 'user-docs', 0)} (dispatched)`,
      },
    });
  });

  test('does not start a pipeline once the budget is spent', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: hangUntilAborted,
      roles: () => ['user'],
    });
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent(), {
        ...baseOptions,
        ...instant,
        fetchImpl,
        timeoutMs: 200,
        budgetMs: 100,
        requestTimeoutMs: 30,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a first run that consumes the whole budget',
      should: 'leave the next pipeline unsent, so a plain re-run can reach it',
      actual: {
        consults: counts.consult,
        unsent: message.includes(
          'user-docs was not sent: the dispatch budget ran out',
        ),
      },
      expected: { consults: 1, unsent: true },
    });
  });

  test('fails at once on a 4xx refusal without reading the conversation', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: async () =>
        new Response('{"error":"forbidden"}', { status: 403 }),
      roles: () => ['user', 'assistant'],
    });
    const message = await technicalDispatchFailure(fetchImpl);
    assert({
      given: 'a definitive 403 from the consult route',
      should: 'throw the refusal without polling',
      actual: { reads: counts.messages, refused: message.includes('403') },
      expected: { reads: 0, refused: true },
    });
  });

  test('addresses a replay attempt by its own id', async () => {
    const event = mergeEvent('fix: only technical');
    const { calls, fetchImpl } = recordingFetch(ok);
    await dispatchDocumentationEvent(event, {
      ...baseOptions,
      fetchImpl,
      attempt: 2,
    });
    assert({
      given: 'a replay with attempt 2',
      should: 'send the attempt-2 id so it cannot collide with the burned one',
      actual: calls.map((call) => call.body.newConversationId),
      expected: [conversationIdFor(event.idempotencyKey, 'technical-docs', 2)],
    });
  });

  test('replays only the pipelines named for the replay', async () => {
    const event = mergeEvent();
    const { calls, fetchImpl } = recordingFetch(ok);
    const outcomes = await dispatchDocumentationEvent(event, {
      ...baseOptions,
      fetchImpl,
      attempt: 1,
      pipelines: ['technical-docs'],
    });
    assert({
      given: 'a replay of the one dead pipeline of a two-pipeline merge',
      should: 'consult only that pipeline, leaving the healthy one alone',
      actual: {
        pipelines: outcomes.map((outcome) => outcome.pipeline),
        ids: calls.map((call) => call.body.newConversationId),
      },
      expected: {
        pipelines: ['technical-docs'],
        ids: [conversationIdFor(event.idempotencyKey, 'technical-docs', 1)],
      },
    });
  });

  test('rejects a replay naming a pipeline the event does not route to', async () => {
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent(), {
        ...baseOptions,
        pipelines: ['blog'],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'DOC_PIPELINES naming blog for a technical and user docs merge',
      should: 'throw rather than consult nothing',
      actual: message,
      expected:
        'DOC_PIPELINES names blog, which this event does not route to (technical-docs, user-docs)',
    });
  });

  test('rejects a malformed replay attempt', async () => {
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent(), {
        ...baseOptions,
        attempt: -1,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a negative replay attempt',
      should: 'refuse it rather than mint an unexpected id',
      actual: message,
      expected: 'DOC_REPLAY_ATTEMPT must be a non-negative integer',
    });
  });

  test('refuses to run without a token', async () => {
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent(), {
        token: '',
        apiUrl: 'https://pagespace.test',
        agentId: 'agent1',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'no PAGESPACE_TOKEN',
      should: 'throw rather than silently skip the dispatch',
      actual: message,
      expected: 'Missing PAGESPACE_TOKEN',
    });
  });

  test('refuses a non-https API host', async () => {
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent(), {
        token: 'tok',
        apiUrl: 'http://pagespace.test',
        agentId: 'agent1',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a plain-http API host',
      should: 'refuse to send the bearer token over it',
      actual: message,
      expected: 'PAGESPACE_API_URL must use https to protect the bearer token',
    });
  });
});

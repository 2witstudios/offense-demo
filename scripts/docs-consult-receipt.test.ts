import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import { dispatchDocumentationEvent } from './docs-consult';
import { conversationIdFor } from './docs-consult-question';
import {
  baseOptions,
  failureOf,
  mergeEvent,
  ok,
  routedFetch,
} from './docs-consult.test-support';
import { DOCUMENTATION_PROMPT_VERSION } from './docs-prompts';
import { RUN_RECORD_COLUMNS, runRecordsFromSheet } from './docs-runs-sheet';

setupRitewayBun();

const header = {
  rowIndex: 0,
  cells: Object.fromEntries(
    RUN_RECORD_COLUMNS.map(({ column, field }) => [
      column,
      { raw: field, value: field },
    ]),
  ),
};

describe('dispatchDocumentationEvent receipt', async () => {
  test('reserves a failed receipt row before consulting and names it', async () => {
    const event = mergeEvent('fix: only technical');
    let appendsAtConsult = -1;
    const stub = routedFetch({
      consult: async () => {
        appendsAtConsult = stub.counts.appends;
        return ok();
      },
      firstRowIndex: 6,
    });
    await dispatchDocumentationEvent(event, {
      ...baseOptions,
      fetchImpl: stub.fetchImpl,
    });
    const [row] = stub.appended;
    const question = String(stub.consults[0]?.body.question);
    assert({
      given: 'a fresh merge event',
      should:
        'append one failed receipt with the trusted keys first, then point the agent at that row',
      actual: {
        appendsAtConsult,
        runId: row?.A,
        workflow: row?.B,
        status: row?.E,
        snapshot: row?.F,
        promptVersion: row?.G,
        idempotencyKey: row?.H,
        namesRow: question.includes('row 7 of the Documentation Runs sheet'),
      },
      expected: {
        appendsAtConsult: 1,
        runId: conversationIdFor(event.idempotencyKey, 'technical-docs'),
        workflow: 'technical-docs',
        status: 'failed',
        snapshot: `${event.repository}@${event.commit}`,
        promptVersion: DOCUMENTATION_PROMPT_VERSION,
        idempotencyKey: event.idempotencyKey,
        namesRow: true,
      },
    });
  });

  test('reserves a row the reconciler reads as not yet covered', async () => {
    const stub = routedFetch({ consult: async () => ok(), firstRowIndex: 1 });
    await dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
      ...baseOptions,
      fetchImpl: stub.fetchImpl,
    });
    const [record] = runRecordsFromSheet([
      header,
      {
        rowIndex: 1,
        cells: Object.fromEntries(
          Object.entries(stub.appended[0] ?? {}).map(([column, raw]) => [
            column,
            { raw, value: raw },
          ]),
        ),
      },
    ]);
    assert({
      given: 'the reserved row before the agent rewrites it',
      should: 'parse as a valid run record whose failed status is no receipt',
      actual: record?.status,
      expected: 'failed',
    });
  });

  test('reports an existing conversation without reserving or consulting', async () => {
    const stub = routedFetch({
      consult: async () => ok(),
      existing: ['user', 'assistant'],
    });
    const outcomes = await dispatchDocumentationEvent(
      mergeEvent('fix: only technical'),
      { ...baseOptions, fetchImpl: stub.fetchImpl },
    );
    assert({
      given: 'a re-run of a merge whose conversation already exists',
      should:
        'report already-dispatched and add no row, so replays leave no noise',
      actual: {
        outcomes: outcomes.map((outcome) => outcome.outcome),
        appends: stub.counts.appends,
        consults: stub.counts.consult,
      },
      expected: {
        outcomes: ['already-dispatched'],
        appends: 0,
        consults: 0,
      },
    });
  });

  test('refuses a reservation answer without a usable row index', async () => {
    const outcomesFor = async (appendBody: unknown) => {
      const stub = routedFetch({ consult: async () => ok(), appendBody });
      let message = 'no throw';
      try {
        await dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
          ...baseOptions,
          fetchImpl: stub.fetchImpl,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      return {
        consults: stub.counts.consult,
        unsent: message.startsWith(
          'Documentation Agent consult for technical-docs was not sent',
        ),
        rowIndex: message.includes(
          'Reserving the technical-docs run record returned no usable row index',
        ),
      };
    };
    const refused = { consults: 0, unsent: true, rowIndex: true };
    const missing = await outcomesFor({ appended: 1 });
    const asText = await outcomesFor({ firstRowIndex: '6' });
    assert({
      given: 'an append answer with the row index missing, or as text',
      should:
        'throw before consulting, rather than point the agent at the wrong row',
      actual: { missing, asText },
      expected: { missing: refused, asText: refused },
    });
  });

  test('bounds a hung reservation by its request cap', async () => {
    // The hung append settles only when its request cap aborts it, so an
    // uncapped append never returns and the test fails on its own timeout.
    const stub = routedFetch({ consult: async () => ok(), hang: ['append'] });
    const message = await failureOf(
      dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        fetchImpl: stub.fetchImpl,
        requestTimeoutMs: 50,
      }),
    );
    assert({
      given: 'a Runs-sheet append that is accepted and never answered',
      should:
        'attempt the append, give up at its cap, and send no consult, instead of outliving the CI job',
      actual: {
        appends: stub.counts.appends,
        consults: stub.counts.consult,
        reservationFailed: message.includes('reserving its receipt failed'),
      },
      expected: {
        appends: 1,
        consults: 0,
        reservationFailed: true,
      },
    });
  });

  test('starts nothing when the budget is shorter than the settlement window', async () => {
    const stub = routedFetch({ consult: async () => ok(), hang: ['reads'] });
    let message = 'no throw';
    try {
      await dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        fetchImpl: stub.fetchImpl,
        timeoutMs: 20,
        budgetMs: 20,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a budget too short for a consult plus the read that settles it',
      should: 'send no question and reserve no row, and say the budget ran out',
      actual: {
        consults: stub.counts.consult,
        appends: stub.counts.appends,
        unsent: message.includes(
          'technical-docs was not sent: the dispatch budget ran out',
        ),
        replay: message.includes(
          'no row was reserved; replay with DOC_REPLAY_ATTEMPT=0 DOC_PIPELINES=technical-docs',
        ),
      },
      expected: { consults: 0, appends: 0, unsent: true, replay: true },
    });
  });

  test('caps the pre-check so a hung lookup cannot starve the consult', async () => {
    const stub = routedFetch({ consult: async () => ok(), hang: ['reads'] });
    const outcomes = await dispatchDocumentationEvent(
      mergeEvent('fix: only technical'),
      {
        ...baseOptions,
        fetchImpl: stub.fetchImpl,
        budgetMs: 60_000,
        requestTimeoutMs: 20,
      },
    );
    assert({
      given: 'a hung conversation lookup with plenty of budget left',
      should: 'give up on the lookup at its own cap, then still consult',
      actual: outcomes.map((outcome) => outcome.outcome),
      expected: ['dispatched'],
    });
  });

  test('does not send a consult the reservation left no time for', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: async () => ok(),
      appendDelayMs: 1_000,
    });
    // Real timers with wide margins: the loop's start guard has 500ms to
    // pass, and the append then outlasts the consult window by 500ms.
    const message = await failureOf(
      dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        fetchImpl,
        budgetMs: 2_000,
        requestTimeoutMs: 1_500,
        attempt: 2,
      }),
    );
    assert({
      given:
        'a budget whose consult window closes while the receipt row is reserved',
      should:
        'leave the consult unsent and name its row and a targeted replay under the same id',
      actual: {
        consults: counts.consult,
        unsent: message.includes(
          'technical-docs was not sent: the dispatch budget ran out',
        ),
        row: message.includes('row 2 of Documentation Runs'),
        replay: message.includes(
          'DOC_REPLAY_ATTEMPT=2 DOC_PIPELINES=technical-docs',
        ),
      },
      expected: { consults: 0, unsent: true, row: true, replay: true },
    });
  });

  test('names the pipeline and a replay when the reservation fails', async () => {
    const { counts, fetchImpl } = routedFetch({
      consult: async () => ok(),
      hang: ['append'],
    });
    const message = await failureOf(
      dispatchDocumentationEvent(mergeEvent('fix: only technical'), {
        ...baseOptions,
        fetchImpl,
        requestTimeoutMs: 50,
      }),
    );
    assert({
      given: 'a Runs-sheet append that times out at its request cap',
      should:
        'send nothing, and name the pipeline and a same-attempt replay rather than a bare timeout',
      actual: {
        consults: counts.consult,
        pipeline: message.startsWith(
          'Documentation Agent consult for technical-docs was not sent: reserving its receipt failed',
        ),
        replay: message.endsWith(
          'replay with DOC_REPLAY_ATTEMPT=0 DOC_PIPELINES=technical-docs',
        ),
      },
      expected: { consults: 0, pipeline: true, replay: true },
    });
  });
});

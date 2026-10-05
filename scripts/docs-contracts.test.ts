import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import {
  parseDocumentationEvent,
  type FindingSeverity,
} from './docs-contracts';
import { canApplyRevision, publicationDecision } from './docs-policy';
import { mergedPullRequestEvent } from './docs-event.test-support';

setupRitewayBun();

/** The message a rejected input throws, or `accepted`. */
const failureOf = (run: () => unknown) => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('parseDocumentationEvent', async () => {
  const validEvent = mergedPullRequestEvent({
    repository: 'offense-demo/offense-demo',
  });

  test('accepts an event produced by this repository', async () => {
    const actual = parseDocumentationEvent(
      JSON.parse(JSON.stringify(validEvent)),
    );
    assert({
      given: 'a serialized repository event',
      should: 'parse to an equivalent typed event',
      actual,
      expected: validEvent,
    });
  });

  test('rejects an unknown event version and unknown pipelines', async () => {
    const mutated = {
      ...JSON.parse(JSON.stringify(validEvent)),
      eventVersion: 'docs-event-v2',
      classification: {
        ...validEvent.classification,
        pipelines: ['oracle-reads'],
      },
    };
    assert({
      given: 'an event with an unknown version and unknown pipelines',
      should: 'fail closed naming both problems',
      actual: failureOf(() => parseDocumentationEvent(mutated)),
      expected:
        'Invalid documentation payload: eventVersion must be "docs-event-v1"; classification.pipelines must be a subset of technical-docs, user-docs, blog, accuracy-review, adversarial-review, prose-review, anti-slop-review',
    });
  });

  test('rejects non-object input', async () => {
    assert({
      given: 'a string instead of an event',
      should: 'throw naming the expected shape',
      actual: failureOf(() => parseDocumentationEvent('not-an-event')),
      expected: 'Invalid documentation payload: event must be an object',
    });
  });
});

describe('publicationDecision', async () => {
  const base = {
    changeKind: 'feature' as const,
    pipelines: ['user-docs'] as const,
    findings: [] as readonly FindingSeverity[],
    runStatus: 'complete' as const,
    textRisk: 'clean' as const,
    approvals: {},
  };

  test('publishes a clean reviewed candidate', async () => {
    const actual = publicationDecision(base).decision;
    assert({
      given: 'a clean, complete, finding-free candidate',
      should: 'publish',
      actual,
      expected: 'publish',
    });
  });

  test('blocks on a blocker finding and reviews on a major finding', async () => {
    assert({
      given: 'a blocker finding',
      should: 'block publication',
      actual: publicationDecision({
        ...base,
        findings: ['blocker'],
      }).decision,
      expected: 'block',
    });
    assert({
      given: 'a major finding',
      should: 'route to human review',
      actual: publicationDecision({ ...base, findings: ['major'] }).decision,
      expected: 'review',
    });
  });

  test('routes flagged text to review even when findings are clean', async () => {
    const actual = publicationDecision({ ...base, textRisk: 'flagged' });
    assert({
      given: 'injection-flagged event text',
      should: 'route to review with a reason naming the risk',
      actual: { decision: actual.decision, reasons: actual.reasons },
      expected: {
        decision: 'review',
        reasons: [
          'the event text matched an injection pattern; a human must review the candidate',
        ],
      },
    });
  });

  test('keeps blog revisions as drafts without explicit approval', async () => {
    const actual = publicationDecision({
      ...base,
      pipelines: ['blog', 'user-docs'],
    });
    assert({
      given: 'a blog pipeline candidate without blog approval',
      should: 'keep it a draft revision',
      actual: actual.decision,
      expected: 'revision',
    });
  });

  test('gates breaking and security changes behind recorded human approval', async () => {
    const gated = { ...base, changeKind: 'security' as const };
    assert({
      given: 'a security change without human approval',
      should: 'route to review',
      actual: publicationDecision(gated).decision,
      expected: 'review',
    });
    assert({
      given: 'a security change with a recorded human approval',
      should: 'publish',
      actual: publicationDecision({
        ...gated,
        approvals: { human: { by: 'jono', at: '2026-09-20T01:00:00.000Z' } },
      }).decision,
      expected: 'publish',
    });
    assert({
      given: 'a security change with an invalid approval timestamp',
      should: 'fail closed to review',
      actual: publicationDecision({
        ...gated,
        approvals: { human: { by: 'jono', at: 'yesterday-ish' } },
      }).decision,
      expected: 'review',
    });
  });

  test('routes failed and partial runs to review without publishing', async () => {
    assert({
      given: 'a failed run',
      should: 'route to review',
      actual: publicationDecision({ ...base, runStatus: 'failed' }).decision,
      expected: 'review',
    });
    assert({
      given: 'a partial run with a minor finding',
      should: 'route to review, not revision',
      actual: publicationDecision({
        ...base,
        runStatus: 'partial',
        findings: ['minor'],
      }).decision,
      expected: 'review',
    });
  });

  test('downgrades minor findings to a draft revision', async () => {
    const actual = publicationDecision({ ...base, findings: ['minor'] });
    assert({
      given: 'only minor findings',
      should: 'produce a review revision instead of publishing',
      actual: actual.decision,
      expected: 'revision',
    });
  });
});

describe('canApplyRevision', async () => {
  test('applies only when the expected revision matches the current revision', async () => {
    assert({
      given: 'matching expected and current revisions',
      should: 'allow the write',
      actual: canApplyRevision({
        expectedRevision: 'rev-7',
        currentRevision: 'rev-7',
      }),
      expected: true,
    });
    assert({
      given: 'a stale expected revision',
      should: 'reject the write',
      actual: canApplyRevision({
        expectedRevision: 'rev-6',
        currentRevision: 'rev-7',
      }),
      expected: false,
    });
    assert({
      given: 'no expected revision declared',
      should: 'reject the write',
      actual: canApplyRevision({
        expectedRevision: undefined,
        currentRevision: 'rev-7',
      }),
      expected: false,
    });
  });
});

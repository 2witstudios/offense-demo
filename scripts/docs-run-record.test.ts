import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import { parseRunRecord } from './docs-contracts';

setupRitewayBun();

describe('parseRunRecord', async () => {
  const validRunRecord = {
    runId: 'run-1',
    workflow: 'accuracy-review',
    startedAt: '2026-09-20T00:00:00.000Z',
    completedAt: '2026-09-20T00:05:00.000Z',
    scope: { pageIds: ['page-1'], changedSince: '2026-09-19T00:00:00.000Z' },
    pagesReviewed: 3,
    findings: [
      {
        pageId: 'page-1',
        sectionId: 'setup',
        claim: 'bun infra:up starts PostgreSQL 16',
        sourceChecked: 'infra/compose.yaml',
        currentEvidence: 'image is postgres:17',
        severity: 'major',
        recommendedAction: 'mark stale and create a review task',
      },
    ],
    autoFixed: 0,
    tasksCreated: 1,
    pagesInvalidated: 0,
    promptVersion: 'docs-prompt-v1',
    sourceSnapshot: 'offense-demo/offense-demo@abc123',
    status: 'complete',
  };

  test('accepts a well-formed run record', async () => {
    const actual = parseRunRecord(JSON.parse(JSON.stringify(validRunRecord)));
    assert({
      given: 'a well-formed run record',
      should: 'parse to a typed run record',
      actual: actual.runId,
      expected: 'run-1',
    });
  });

  test('carries the optional idempotency key and notes, typed', async () => {
    const withExtras = {
      ...JSON.parse(JSON.stringify(validRunRecord)),
      idempotencyKey: 'offense-demo/offense-demo:abc123:pull_request.merged',
      notes: 'No section cites the changed paths.',
    };
    let message = '';
    try {
      parseRunRecord({ ...withExtras, notes: 7 });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a record echoing its event key and a note, then a numeric note',
      should: 'keep both strings and reject the non-string note',
      actual: {
        key: parseRunRecord(withExtras).idempotencyKey,
        notes: parseRunRecord(withExtras).notes,
        rejectsNumber: message.includes('notes'),
      },
      expected: {
        key: 'offense-demo/offense-demo:abc123:pull_request.merged',
        notes: 'No section cites the changed paths.',
        rejectsNumber: true,
      },
    });
  });

  test('rejects unknown status and unknown severity', async () => {
    const mutated = {
      ...JSON.parse(JSON.stringify(validRunRecord)),
      status: 'ok',
      findings: [{ ...validRunRecord.findings[0], severity: 'catastrophic' }],
    };
    let message = '';
    try {
      parseRunRecord(mutated);
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a run record with an unknown status and severity',
      should: 'fail closed naming both problems',
      actual: message.includes('status') && message.includes('severity'),
      expected: true,
    });
  });

  test('rejects negative counters and missing claim fields', async () => {
    const mutated = {
      ...JSON.parse(JSON.stringify(validRunRecord)),
      pagesReviewed: -1,
      findings: [{ severity: 'minor' }],
    };
    let message = '';
    try {
      parseRunRecord(mutated);
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a run record with a negative counter and a claim-less finding',
      should: 'fail closed naming both problems',
      actual: message.includes('pagesReviewed') && message.includes('claim'),
      expected: true,
    });
  });

  test('rejects null for optional fields typed string-or-absent', async () => {
    const problemsFor = (field: string) => {
      try {
        parseRunRecord({
          ...JSON.parse(JSON.stringify(validRunRecord)),
          [field]: null,
        });
        return 'accepted';
      } catch (error) {
        return (error as Error).message.includes(field) ? 'rejected' : 'other';
      }
    };
    assert({
      given: 'null in each optional run-record field',
      should:
        'reject it, since the parsed type allows only a string or nothing',
      actual: [
        'baseRevision',
        'resultingRevision',
        'idempotencyKey',
        'notes',
      ].map(problemsFor),
      expected: ['rejected', 'rejected', 'rejected', 'rejected'],
    });
  });
});

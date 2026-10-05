import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  declaredBuilder,
  commentBodies,
  linkedPageIds,
  recordFromPage,
} from './review-record';
import {
  pr,
  record,
  rules,
  sha,
  verifyReviewRecord,
} from './review-record.test-support';

setupRitewayBun();

const url = `https://pagespace.ai/dashboard/${rules.driveId}`;

describe('linkedPageIds', () => {
  test('collects PageSpace page links from the PR body and comments', () => {
    assert({
      given: 'a body and comments linking two records, one twice',
      should: 'return each page id once, in order',
      actual: linkedPageIds(
        [
          `Reviews: [record](${url}/rec1111111111111111111111) — APPROVE`,
          `see ${url}/rec2222222222222222222222 and ${url}/rec1111111111111111111111`,
        ],
        rules,
      ),
      expected: ['rec1111111111111111111111', 'rec2222222222222222222222'],
    });
  });
});

describe('declaredBuilder', () => {
  test('reads the builder the PR body declares', () => {
    assert({
      given: 'a PR body with and without a Builder line',
      should: 'return the id or undefined',
      actual: [
        declaredBuilder('## PageSpace\nBuilder: ag-za6fxjsn\n'),
        declaredBuilder('no builder'),
      ],
      expected: ['ag-za6fxjsn', undefined],
    });
  });
});

describe('verifyReviewRecord', () => {
  test('passes an independent approving record for the exact head SHA', () => {
    assert({
      given: 'a record for the head SHA by a reviewer who is not the builder',
      should: 'set review-record to success linking the record',
      actual: verifyReviewRecord(pr, [record()]),
      expected: {
        state: 'success',
        description: 'Independent review by ag-reviewer: APPROVE WITH MINORS',
        recordId: 'rec1111111111111111111111',
      },
    });
  });

  test('stays pending until a record for this SHA exists', () => {
    assert({
      given: 'no records, and a record for an older SHA',
      should: 'be pending, never success',
      actual: [
        verifyReviewRecord(pr, []).state,
        verifyReviewRecord(pr, [
          record({
            title: `Review record — GRD-6.1 (${'b'.repeat(40)})`,
            candidate: `Candidate: ${'b'.repeat(40)} · PR #57 · Builder: ag-builder · Reviewer: ag-reviewer`,
          }),
        ]).state,
      ],
      expected: ['pending', 'pending'],
    });
  });

  test('refuses a record the builder minted for its own PR', () => {
    assert({
      given: 'a record whose reviewer is the declared builder',
      should: 'fail',
      actual: verifyReviewRecord(pr, [
        record({
          candidate: `Candidate: ${sha} · PR #57 · Builder: ag-builder · Reviewer: ag-builder`,
        }),
      ]),
      expected: {
        state: 'failure',
        description: 'The reviewer ag-builder is the builder of this PR',
        recordId: 'rec1111111111111111111111',
      },
    });
  });

  test('refuses records that do not bind this PR, builder and verdict', () => {
    const results = [
      verifyReviewRecord({ ...pr, body: 'no builder line' }, [record()]),
      verifyReviewRecord(pr, [
        record({
          candidate: `Candidate: ${sha} · PR #58 · Builder: ag-builder · Reviewer: ag-reviewer`,
        }),
      ]),
      verifyReviewRecord(pr, [
        record({
          candidate: `Candidate: ${sha} · PR #57 · Builder: ag-other · Reviewer: ag-reviewer`,
        }),
      ]),
      verifyReviewRecord(pr, [
        record({
          verdict: '1 blocker / 0 major / 0 minor / 0 nit — CHANGES REQUESTED',
        }),
      ]),
      verifyReviewRecord(pr, [record({ candidate: 'no candidate line' })]),
    ];
    assert({
      given:
        'no declared builder, another PR, another builder, changes requested, and no candidate line',
      should: 'fail each with its reason',
      actual: results.map((result) => [result.state, result.description]),
      expected: [
        ['failure', 'The PR body declares no "Builder: <id>" line'],
        ['failure', 'The record reviews PR #58, not #57'],
        [
          'failure',
          'The record names builder ag-other; the PR declares ag-builder',
        ],
        ['failure', 'The verdict is not an approval: CHANGES REQUESTED'],
        [
          'failure',
          'The record has no "Candidate: <sha> · PR #n · Builder: … · Reviewer: …" line',
        ],
      ],
    });
  });

  test('refuses a no-findings approval without integration tests and a negative control', () => {
    const clean = '0 blocker / 0 major / 0 minor / 0 nit — APPROVE';
    assert({
      given: 'a clean verdict with and without the required evidence',
      should: 'pass only when both were run',
      actual: [
        verifyReviewRecord(pr, [record({ verdict: clean })]).state,
        verifyReviewRecord(pr, [
          record({ verdict: clean, gates: 'bun check: PASS' }),
        ]).description,
      ],
      expected: [
        'success',
        'A no-findings verdict needs bun test:integration PASS and a negative control in Gates run',
      ],
    });
  });

  test('reads only the final verdict line under the Verdict heading', () => {
    const changes = '1 blocker / 1 major / 0 minor / 0 nit — CHANGES REQUESTED';
    const quoting = [
      // A #65-style draft: a finding names the plan-review parser and quotes
      // an approval before the real verdict line.
      '- [ ] major · scripts/plan-review.ts:9 · lastVerdict reads "Verdict: APPROVE" from the first match · GRD-6.9',
      '- [ ] blocker · the Reviewer contract lists Verdict: APPROVE | APPROVE WITH MINORS | CHANGES REQUESTED · GRD-6.9',
    ].join('\n');
    const verdicts = [
      verifyReviewRecord(pr, [record({ findings: quoting, verdict: changes })]),
      verifyReviewRecord(pr, [
        record({
          verdict: '0 blocker / 0 major / 1 minor / 0 nit — NOT APPROVED',
        }),
      ]),
      verifyReviewRecord(pr, [
        record({
          verdict: '0 blocker / 0 major / 1 minor / 0 nit — ALL RESOLVED',
        }),
      ]),
      verifyReviewRecord(pr, [
        record({ verdict: '0 blocker / 0 major / 1 minor / 0 nit — APPROVE.' }),
      ]),
    ];
    assert({
      given:
        'CHANGES REQUESTED after findings quoting approvals, NOT APPROVED, ALL RESOLVED, and APPROVE with trailing text',
      should:
        'never mint success: only an exact APPROVE or APPROVE WITH MINORS approves',
      actual: verdicts.map((verdict) => [verdict.state, verdict.description]),
      expected: [
        ['failure', 'The verdict is not an approval: CHANGES REQUESTED'],
        ['failure', 'The verdict is not an approval: NOT APPROVED'],
        ['failure', 'The verdict is not an approval: ALL RESOLVED'],
        ['failure', 'The verdict is not an approval: APPROVE.'],
      ],
    });
  });

  test('refuses an approval that leaves a blocker or major open, or has no verdict line', () => {
    const verdicts = [
      verifyReviewRecord(pr, [
        record({ verdict: '1 blocker / 0 major / 0 minor / 0 nit — APPROVE' }),
      ]),
      verifyReviewRecord(pr, [
        record({
          verdict:
            '0 blocker / 2 major / 0 minor / 0 nit — APPROVE WITH MINORS',
        }),
      ]),
      verifyReviewRecord(pr, [record({ verdict: 'APPROVE' })]),
    ];
    assert({
      given:
        'APPROVE with a blocker, APPROVE WITH MINORS with majors, and a bare APPROVE',
      should: 'fail each with its reason',
      actual: verdicts.map((verdict) => [verdict.state, verdict.description]),
      expected: [
        ['failure', 'The verdict approves with 1 blocker and 0 major open'],
        ['failure', 'The verdict approves with 0 blocker and 2 major open'],
        [
          'failure',
          'The record has no "n blocker / n major / n minor / n nit — <verdict>" line under Verdict',
        ],
      ],
    });
  });

  test('refuses when any record for the SHA does not approve', () => {
    assert({
      given:
        'an APPROVE WITH MINORS record and a CHANGES REQUESTED record from another reviewer on the same SHA',
      should: 'fail from the record that requests changes',
      actual: verifyReviewRecord(pr, [
        record(),
        {
          ...record({
            candidate: `Candidate: ${sha} · PR #57 · Builder: ag-builder · Reviewer: ag-second`,
            verdict:
              '1 blocker / 0 major / 0 minor / 0 nit — CHANGES REQUESTED',
          }),
          id: 'rec2222222222222222222222',
        },
      ]),
      expected: {
        state: 'failure',
        description: 'The verdict is not an approval: CHANGES REQUESTED',
        recordId: 'rec2222222222222222222222',
      },
    });
  });

  test('reads the no-findings evidence from its own Gates lines', () => {
    const clean = '0 blocker / 0 major / 0 minor / 0 nit — APPROVE';
    assert({
      given:
        'a clean verdict whose gates only mention the phrases: integration not run, no negative control',
      should: 'fail for missing evidence',
      actual: verifyReviewRecord(pr, [
        record({
          verdict: clean,
          gates: 'bun test:integration: PASS? not run. Negative control: none',
        }),
      ]).description,
      expected:
        'A no-findings verdict needs bun test:integration PASS and a negative control in Gates run',
    });
  });

  test('fails closed when a linked page cannot be read', () => {
    assert({
      given: 'an approving record and a linked page that returned an error',
      should: 'fail, naming the page, instead of judging the rest',
      actual: verifyReviewRecord(pr, [record()], ['rec2222222222222222222222']),
      expected: {
        state: 'failure',
        description:
          'Linked page rec2222222222222222222222 could not be read; review-record fails closed',
      },
    });
  });

  test('reads only the last Verdict heading, and only a real heading line', () => {
    const appended = record({
      verdict: [
        '1 blocker / 0 major / 0 minor / 0 nit — CHANGES REQUESTED',
        '## Verdict',
        '0 blocker / 0 major / 1 minor / 0 nit — APPROVE WITH MINORS',
      ].join('\n'),
    });
    const prose = record({
      verdict: [
        '1 blocker / 0 major / 0 minor / 0 nit — CHANGES REQUESTED',
        'Quoting the earlier verdict',
        '0 blocker / 0 major / 1 minor / 0 nit — APPROVE WITH MINORS',
      ].join('\n'),
    });
    assert({
      given:
        'a record whose last Verdict heading approves, and one whose prose line mentioning a verdict precedes an approval below the real heading',
      should:
        'take the last heading, and never a line that only contains the word',
      actual: [
        verifyReviewRecord(pr, [appended]).state,
        verifyReviewRecord(pr, [prose]).state,
      ],
      expected: ['success', 'failure'],
    });
  });

  test('reads no-findings evidence only from Gates run, and refuses a PASS that did not run', () => {
    const clean = '0 blocker / 0 major / 0 minor / 0 nit — APPROVE';
    const quoted = record({
      verdict: clean,
      gates: 'bun check: PASS',
      findings: [
        'bun test:integration: PASS (165 pass)',
        'Negative control run: yes',
      ].join('\n'),
    });
    const notRun = record({
      verdict: clean,
      gates: [
        'bun test:integration: PASS (not run)',
        'Negative control run: yes',
      ].join('\n'),
    });
    const why =
      'A no-findings verdict needs bun test:integration PASS and a negative control in Gates run';
    assert({
      given:
        'evidence lines quoted under Findings, and "PASS (not run)" under Gates run',
      should: 'refuse both',
      actual: [
        verifyReviewRecord(pr, [quoted]).description,
        verifyReviewRecord(pr, [notRun]).description,
      ],
      expected: [why, why],
    });
  });

  test('reads records only from the Offense Demo drive', () => {
    assert({
      given: 'links to a Offense Demo page and to a page in another drive',
      should: 'return only the Offense Demo page',
      actual: linkedPageIds(
        [
          `${url}/rec1111111111111111111111 https://pagespace.ai/dashboard/otherdrive0000000000000/rec3333333333333333333333`,
        ],
        rules,
      ),
      expected: ['rec1111111111111111111111'],
    });
  });

  test('refuses a fetched page that lives in another drive', () => {
    assert({
      given:
        'a page fetched through a Offense Demo link, from the Offense Demo drive and from another drive',
      should: 'keep the Offense Demo page and treat the other as unreadable',
      actual: [
        recordFromPage(
          'rec1111111111111111111111',
          {
            title: 't',
            content: 'c',
            driveId: rules.driveId,
          },
          rules.driveId,
        )?.id,
        recordFromPage(
          'rec1111111111111111111111',
          {
            title: 't',
            content: 'c',
            driveId: 'otherdrive0000000000000',
          },
          rules.driveId,
        ),
      ],
      expected: ['rec1111111111111111111111', undefined],
    });
  });

  test('reads comment bodies from every page of a paginated response', () => {
    assert({
      given:
        'two pages of issue comments, as gh api --paginate --slurp returns them',
      should: 'return every body in order',
      actual: commentBodies([[{ body: 'a' }, { body: 'b' }], [{ body: 'c' }]]),
      expected: ['a', 'b', 'c'],
    });
  });
});

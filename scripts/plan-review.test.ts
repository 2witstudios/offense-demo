import { readdirSync } from 'node:fs';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  adrFile,
  adrIndex,
  parseVerdict,
  planReviewPrompt,
} from './plan-review';

setupRitewayBun();

describe('planReviewPrompt', () => {
  const prompt = planReviewPrompt({
    agents: 'AGENTS RULES: greenfield over backward compatibility',
    adrs: [
      { number: '0018', title: 'cuid2 identifiers' },
      { number: '0023', title: 'Greenfield baseline' },
    ],
    plan: '<h1>Plan — X</h1><p>Backfill existing rows.</p>',
  });

  test('gives the external reviewer the repository constraints and the plan', () => {
    assert({
      given: 'AGENTS.md, the ADR index and a plan',
      should: 'include all three and the required verdict line',
      actual: [
        prompt.includes('AGENTS RULES'),
        prompt.includes('ADR 0023: Greenfield baseline'),
        prompt.includes('Backfill existing rows.'),
        prompt.includes('PLAN REVIEW: APPROVE'),
      ],
      expected: [true, true, true, true],
    });
  });

  test('asks for contradictions with accepted decisions before tasking', () => {
    assert({
      given: 'the prompt',
      should: 'name the checks the retrospective found missing',
      actual: [
        /contradict/i.test(prompt),
        /prerequisite/i.test(prompt),
        /superseded/i.test(prompt),
      ],
      expected: [true, true, true],
    });
  });
});

describe('adrIndex', () => {
  test('reads number and title from decision records', () => {
    assert({
      given: 'decision file names and their first lines',
      should: 'return the index sorted by number',
      actual: adrIndex([
        {
          file: '0023-greenfield-baseline.md',
          firstLine: '# 0023: Greenfield baseline',
        },
        { file: '0018-cuid2.md', firstLine: '# 0018: cuid2 identifiers' },
        {
          file: '0001-bun-runtime.md',
          firstLine: '# ADR 0001: Bun as the only runtime',
        },
        { file: '0040-no-heading.md', firstLine: 'Status: draft' },
        { file: 'README.md', firstLine: '# Decisions' },
      ]),
      expected: [
        { number: '0001', title: 'Bun as the only runtime', superseded: false },
        { number: '0018', title: 'cuid2 identifiers', superseded: false },
        { number: '0023', title: 'Greenfield baseline', superseded: false },
        { number: '0040', title: 'no heading', superseded: false },
      ],
    });
  });

  test('indexes every decision record in the repository', () => {
    const dir = new URL('../docs/decisions/', import.meta.url).pathname;
    const files = readdirSync(dir).filter((file) => /^\d{4}-/.test(file));
    assert({
      given: 'docs/decisions, whose older records are headed "# ADR 0001: …"',
      should:
        'feed every one of them, titled from its heading, with none superseded',
      actual: (() => {
        const index = adrIndex(files.map((file) => adrFile(dir, file)));
        return [
          index.length,
          index.find((adr) => adr.number === '0001')?.title,
          index.filter((adr) => adr.superseded).map((adr) => adr.number),
        ];
      })(),
      expected: [
        files.length,
        'Bun as the only runtime and package manager',
        [],
      ],
    });
  });
});

describe('superseded decisions', () => {
  test('labels a superseded ADR in the prompt so a plan cannot lean on it', () => {
    const adrs = adrIndex([
      {
        file: '0022-legacy.md',
        firstLine: '# 0022: Legacy identifier compatibility',
        status:
          'Status: superseded by [ADR 0023](0023-greenfield-baseline.md).',
      },
      {
        file: '0023-greenfield.md',
        firstLine: '# 0023: Greenfield baseline',
        status: 'Status: accepted.',
      },
    ]);
    const prompt = planReviewPrompt({ agents: '', adrs, plan: '' });
    assert({
      given: 'a superseded ADR 0022 and an accepted ADR 0023',
      should: 'mark 0022 as superseded and 0023 as in force',
      actual: [
        prompt.includes(
          'ADR 0022: Legacy identifier compatibility (superseded: not in force)',
        ),
        prompt.includes('ADR 0023: Greenfield baseline\n'),
      ],
      expected: [true, true],
    });
  });
});

describe('parseVerdict', () => {
  test('reads the verdict line and refuses output without one', () => {
    assert({
      given:
        'an approving review, a change request, and output with no verdict',
      should: 'return the verdict or undefined',
      actual: [
        parseVerdict('findings…\nPLAN REVIEW: APPROVE\n'),
        parseVerdict('PLAN REVIEW: CHANGES REQUESTED'),
        parseVerdict('looks fine'),
        parseVerdict('Final: PLAN REVIEW: APPROVE'),
        parseVerdict('PLAN REVIEW: APPROVE once fixed'),
      ],
      expected: [
        'APPROVE',
        'CHANGES REQUESTED',
        undefined,
        undefined,
        undefined,
      ],
    });
  });

  test('reads the last whole verdict line, not a verdict quoted earlier', () => {
    assert({
      given:
        'an approval quoted mid-sentence before a final change request, and two verdict lines',
      should: 'return the final verdict line each time',
      actual: [
        parseVerdict(
          'I would give PLAN REVIEW: APPROVE once the backfill goes.\nPLAN REVIEW: CHANGES REQUESTED\n',
        ),
        parseVerdict(
          'PLAN REVIEW: APPROVE\nmore findings\nPLAN REVIEW: CHANGES REQUESTED',
        ),
      ],
      expected: ['CHANGES REQUESTED', 'CHANGES REQUESTED'],
    });
  });
});

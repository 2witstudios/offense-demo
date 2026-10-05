import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { expect } from 'bun:test';
import { applyMutation, formatReport, type Control } from './negative-controls';

setupRitewayBun();

const control: Control = {
  name: 'example guard',
  file: 'example.ts',
  find: 'if (guarded) deny();\n',
  replace: '',
  testFile: 'example.test.ts',
};

describe('applyMutation', () => {
  test('removes exactly the matched sabotage text', () => {
    assert({
      given: 'source containing exactly one occurrence of the guard',
      should: 'return the source with the guard removed',
      actual: applyMutation('before\nif (guarded) deny();\nafter\n', control),
      expected: 'before\nafter\n',
    });
  });

  test('refuses to run when the source has drifted to zero occurrences', () => {
    expect(() => applyMutation('nothing to sabotage here', control)).toThrow(
      /expected exactly one occurrence/,
    );
  });

  test('refuses to run when the target text repeats', () => {
    const twice = 'if (guarded) deny();\nif (guarded) deny();\n';
    expect(() => applyMutation(twice, control)).toThrow(
      /expected exactly one occurrence/,
    );
  });
});

describe('formatReport', () => {
  test('reports PASS only when every control sabotaged red and restored green', () => {
    const passing = formatReport({
      ok: true,
      controls: [
        {
          name: 'example guard',
          file: 'example.ts',
          testFile: 'example.test.ts',
          diff: '- guarded\n+ (removed)',
          red: { exitCode: 1, output: 'FAIL' },
          green: { exitCode: 0, output: 'PASS' },
          ok: true,
        },
      ],
      blocked: [{ name: 'vendor guard', reason: 'lives in node_modules' }],
    });
    assert({
      given: 'a report whose one control sabotaged red and restored green',
      should:
        'render an overall PASS heading and the diff, red and green sections',
      actual: {
        hasPass: passing.includes('Overall: PASS'),
        hasDiff: passing.includes('guarded'),
        hasRed: passing.includes('FAIL'),
        hasGreen: passing.includes('PASS (red then green'),
        hasBlocked: passing.includes('vendor guard'),
      },
      expected: {
        hasPass: true,
        hasDiff: true,
        hasRed: true,
        hasGreen: true,
        hasBlocked: true,
      },
    });
  });

  test('reports FAIL when a control never actually failed under sabotage', () => {
    const failing = formatReport({
      ok: false,
      controls: [
        {
          name: 'ineffective guard',
          file: 'example.ts',
          testFile: 'example.test.ts',
          diff: '',
          red: { exitCode: 0, output: 'PASS' },
          green: { exitCode: 0, output: 'PASS' },
          ok: false,
        },
      ],
      blocked: [],
    });
    assert({
      given: 'a control whose sabotaged run still passed',
      should: 'render an overall FAIL heading and mark that control FAIL',
      actual:
        failing.includes('Overall: FAIL') && failing.includes('Result: FAIL'),
      expected: true,
    });
  });
});

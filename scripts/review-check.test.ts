import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  checkedRecordIds,
  dispatchCommand,
  parseCheckArgs,
} from './review-check';

setupRitewayBun();

describe('parseCheckArgs', () => {
  test('parses the record page id, PR number, and optional --sha and --dispatch', () => {
    assert({
      given: 'a record id with --pr, and one with --sha and --dispatch too',
      should: 'read every field',
      actual: [
        parseCheckArgs(['rec1111111111111111111111', '--pr', '103']),
        parseCheckArgs([
          'rec1111111111111111111111',
          '--pr',
          '103',
          '--sha',
          'a'.repeat(40),
          '--dispatch',
        ]),
      ],
      expected: [
        {
          recordPageId: 'rec1111111111111111111111',
          pr: 103,
          sha: undefined,
          dispatch: false,
        },
        {
          recordPageId: 'rec1111111111111111111111',
          pr: 103,
          sha: 'a'.repeat(40),
          dispatch: true,
        },
      ],
    });
  });

  test('refuses a missing record id, a missing --pr, or a non-numeric --pr', () => {
    assert({
      given: 'no arguments, no --pr, and a non-numeric --pr',
      should: 'return the usage error for each',
      actual: [
        parseCheckArgs([]),
        parseCheckArgs(['rec1111111111111111111111']),
        parseCheckArgs(['rec1111111111111111111111', '--pr', 'abc']),
        parseCheckArgs(['--pr', '103']),
      ].map((result) => 'error' in result),
      expected: [true, true, true, true],
    });
  });
});

describe('checkedRecordIds', () => {
  test('dedupes the given record id with whatever the PR already links', () => {
    assert({
      given:
        'a record id that is also among the linked ids, in a different position',
      should: 'return each id once',
      actual: checkedRecordIds('rec1111111111111111111111', [
        'rec2222222222222222222222',
        'rec1111111111111111111111',
      ]),
      expected: ['rec1111111111111111111111', 'rec2222222222222222222222'],
    });
  });

  test('keeps a record id the PR has not linked yet, for a record still being drafted', () => {
    assert({
      given: 'a fresh record id and no linked ids at all',
      should: 'return just the fresh id',
      actual: checkedRecordIds('rec1111111111111111111111', []),
      expected: ['rec1111111111111111111111'],
    });
  });
});

describe('dispatchCommand', () => {
  test('builds the gh workflow run command for the given PR, not GitHub itself', () => {
    assert({
      given: 'PR #103',
      should: 'return the gh workflow run arguments, without running gh',
      actual: dispatchCommand(103),
      expected: ['workflow', 'run', 'review-record.yml', '-f', 'pr=103'],
    });
  });
});

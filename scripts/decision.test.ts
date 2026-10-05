import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { recordDecision, type DecisionDeps } from './decision';

setupRitewayBun();

const context = 'contextxxxxxxxxxxxxxxxxx';

function fakes() {
  const boardCalls: string[][] = [];
  const notices: string[] = [];
  const deps: DecisionDeps = {
    pendingDecisionsId: 'pendingdecisionsxxxxxxxx',
    driveUrl: 'https://pagespace.ai/dashboard/drive1',
    board: (args) => {
      boardCalls.push([...args]);
      return {
        code: 0,
        pageId: 'dec1111111111111111111111',
        title: 'DEC-3 — x',
      };
    },
    notify: (message) => {
      notices.push(message);
      return true;
    },
    out: () => undefined,
  };
  return { deps, boardCalls, notices };
}

describe('bun decision:record', () => {
  test('records the decision as an open DEC-n item and notifies the owner', () => {
    const { deps, boardCalls, notices } = fakes();
    const code = recordDecision(deps, [
      'Use one machine user for builders and reviewers',
      '--context',
      context,
      '--why',
      'GitHub allows one free machine account',
    ]);
    assert({
      given:
        'a decision made on the owner’s behalf with its context and reason',
      should:
        'create a DEC-numbered task on Pending decisions linked to the context, and notify the owner',
      actual: {
        code,
        board: boardCalls[0]?.slice(0, 5),
        related: boardCalls[0]?.includes(`Context=${context}`),
        criterion: boardCalls[0]?.some((arg) =>
          arg.includes('confirm or overrule'),
        ),
        notice:
          notices[0]?.includes('DEC-3') &&
          notices[0]?.includes('open until you confirm or overrule') &&
          notices[0]?.includes(
            'https://pagespace.ai/dashboard/drive1/dec1111111111111111111111',
          ),
      },
      expected: {
        code: 0,
        board: [
          'create',
          'pendingdecisionsxxxxxxxx',
          '--prefix',
          'DEC',
          '--title',
        ],
        related: true,
        criterion: true,
        notice: true,
      },
    });
  });

  test('refuses a decision without text or context', () => {
    const { deps, boardCalls } = fakes();
    assert({
      given: 'no decision text, and no context page',
      should: 'exit 2 and record nothing',
      actual: [
        recordDecision(deps, ['--context', context]),
        recordDecision(deps, ['Do x']),
        boardCalls.length,
      ],
      expected: [2, 2, 0],
    });
  });
});

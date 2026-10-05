import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { checkoutWarning, sessionStartOutput } from './session-start';

setupRitewayBun();

describe('checkoutWarning', () => {
  test('warns when the main checkout is not on main', () => {
    assert({
      given: 'the main checkout on a feature branch',
      should: 'warn and name the branch',
      actual: checkoutWarning({
        mainCheckout: true,
        branch: 'docs/review-skill',
      }),
      expected:
        'The main checkout is on docs/review-skill, not main. It must stay on main: agents never commit, check out or merge there. Move this work to a pu worktree and run `git switch main` here.',
    });
  });

  test('stays quiet on main and in worktrees', () => {
    assert({
      given: 'the main checkout on main, and a worktree on its branch',
      should: 'return no warning',
      actual: [
        checkoutWarning({ mainCheckout: true, branch: 'main' }),
        checkoutWarning({ mainCheckout: false, branch: 'pu/grd-6' }),
      ],
      expected: [undefined, undefined],
    });
  });
});

describe('sessionStartOutput', () => {
  test('shows the warning to the user and the session', () => {
    assert({
      given: 'a warning',
      should: 'emit a SessionStart systemMessage and context',
      actual: sessionStartOutput('careful'),
      expected: {
        systemMessage: 'careful',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'careful',
        },
      },
    });
  });
});

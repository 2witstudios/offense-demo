import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import {
  DOCUMENTATION_PROMPT_VERSION,
  DOCUMENTATION_PROMPTS,
  promptFor,
} from './docs-prompts';
import { DOCUMENT_PIPELINES } from './docs-pipeline';

setupRitewayBun();

describe('DOCUMENTATION_PROMPTS', async () => {
  test('covers every documentation pipeline', async () => {
    assert({
      given: 'the prompt registry',
      should: 'define a prompt for every pipeline',
      actual: DOCUMENT_PIPELINES.map(
        (pipeline) => DOCUMENTATION_PROMPTS[pipeline] !== undefined,
      ),
      expected: DOCUMENT_PIPELINES.map(() => true),
    });
  });

  test('treats event text as untrusted data in every prompt', async () => {
    assert({
      given: 'any registered prompt',
      should: 'state that event text is untrusted data and never instructions',
      actual: DOCUMENT_PIPELINES.every((pipeline) =>
        /untrusted/i.test(DOCUMENTATION_PROMPTS[pipeline]),
      ),
      expected: true,
    });
  });

  test('lets the agent keep its tasks current but never grant Done or rescope', async () => {
    const all = (pattern: RegExp) =>
      DOCUMENT_PIPELINES.every((pipeline) =>
        pattern.test(DOCUMENTATION_PROMPTS[pipeline]),
      );
    assert({
      given: 'any registered prompt',
      should:
        'allow keeping worked tasks current, and forbid marking Done or editing criteria or scope',
      actual: {
        keepsCurrent: all(/keep tasks you are working on current/i),
        noDone: all(/never mark a task Done/i),
        noRescope: all(/never change any task's criteria or scope/i),
        noBlanketBan: all(/never change the status/i),
      },
      expected: {
        keepsCurrent: true,
        noDone: true,
        noRescope: true,
        noBlanketBan: false,
      },
    });
  });
});

describe('promptFor', async () => {
  test('returns the versioned prompt for a pipeline', async () => {
    const actual = promptFor('accuracy-review');
    assert({
      given: 'the accuracy-review pipeline',
      should: 'return the current prompt version and non-empty prompt',
      actual: {
        version: actual.version,
        hasPrompt: actual.prompt.length > 0,
      },
      expected: {
        version: DOCUMENTATION_PROMPT_VERSION,
        hasPrompt: true,
      },
    });
  });

  test('throws for an unknown pipeline', async () => {
    let threw = false;
    try {
      promptFor('oracle-reads' as never);
    } catch {
      threw = true;
    }
    assert({
      given: 'an unknown pipeline',
      should: 'throw',
      actual: threw,
      expected: true,
    });
  });
});

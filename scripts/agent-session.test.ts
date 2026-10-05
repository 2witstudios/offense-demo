import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { AUTONOMY_ENV, sessionIsAgent } from './agent-session';
import { loadProjectConfig } from './project-config';

setupRitewayBun();

describe('sessionIsAgent', () => {
  test('is true only for a fully autonomous run', () => {
    assert({
      given: 'AGENT_AUTONOMOUS=1, another value, and no value',
      should: 'treat only 1 as an autonomous agent session',
      actual: [
        sessionIsAgent({ AGENT_AUTONOMOUS: '1' }),
        sessionIsAgent({ AGENT_AUTONOMOUS: '0' }),
        sessionIsAgent({}),
      ],
      expected: [true, false, false],
    });
  });
});

describe('AUTONOMY_ENV', () => {
  test('matches the autonomy variable project.config.json declares', () => {
    assert({
      given: 'project.config.json autonomyEnv',
      should: 'name the same variable every script, hook and launcher reads',
      actual: loadProjectConfig().autonomyEnv,
      expected: AUTONOMY_ENV,
    });
  });
});

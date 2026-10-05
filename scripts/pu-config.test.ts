import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

type PuConfig = {
  envFiles: string[];
  agents: Record<string, { command: string; launchArgs?: string[] }>;
};

const config = Bun.YAML.parse(
  await Bun.file(`${root}/.pu/config.yaml`).text(),
) as PuConfig;
const context = await Bun.file(`${root}/.pu/agent-context.md`).text();

describe('committed pu configuration', () => {
  test('copies the agent identity into every worktree', () => {
    assert({
      given: 'the committed .pu/config.yaml',
      should: 'list .env.agent among the env files pu copies',
      actual: config.envFiles.includes('.env.agent'),
      expected: true,
    });
  });

  test('starts every coding agent through the identity launcher', () => {
    assert({
      given: 'the claude, codex, opencode and terminal agent definitions',
      should:
        'run each through scripts/agent-launch.sh with no extra launch args',
      actual: ['claude', 'codex', 'opencode', 'terminal'].map((name) => [
        config.agents[name]?.command.split(' ').slice(0, 2),
        config.agents[name]?.launchArgs,
      ]),
      expected: [
        [['scripts/agent-launch.sh', 'claude'], []],
        [['scripts/agent-launch.sh', 'codex'], []],
        [['scripts/agent-launch.sh', 'opencode'], []],
        [['scripts/agent-launch.sh', 'shell'], []],
      ],
    });
  });
});

describe('committed pu agent context', () => {
  test('does not contradict AGENTS.md', () => {
    assert({
      given: 'the context pu injects into every agent',
      should:
        'name AGENTS.md, never CLAUDE.md, and never forbid filing follow-ups',
      actual: {
        namesAgentsMap: context.includes('AGENTS.md'),
        namesClaudeMd: context.includes('CLAUDE.md'),
        forbidsFollowUps: /no\s+"?follow-up tasks/i.test(context),
      },
      expected: {
        namesAgentsMap: true,
        namesClaudeMd: false,
        forbidsFollowUps: false,
      },
    });
  });

  test('states the autonomous merge rule', () => {
    assert({
      given: 'the context pu injects into every agent',
      should: 'make the auto-merge request conditional on the live ruleset',
      actual: [
        context.includes('gh pr merge --auto --merge'),
        context.includes('ready for owner merge'),
      ],
      expected: [true, true],
    });
  });
});

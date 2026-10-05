import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { parseDotenv } from './dotenv';
import {
  assessAgentEnv,
  assessGithubIdentity,
  exportScript,
  identityRegime,
  regimeCheck,
} from './agent-identity';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const example = await Bun.file(`${root}/.env.agent.example`).text();
const filled = example.replace(/^GH_TOKEN=.*$/m, 'GH_TOKEN=agent-token-value');

describe('parseDotenv', () => {
  test('reads comments, export, quotes and inline comments', () => {
    assert({
      given: 'an env file with the forms the repository uses',
      should: 'return each key with its unquoted value',
      actual: parseDotenv(
        [
          '# comment',
          'A=1',
          'export B="two words"',
          "C='!gh auth git-credential'",
          'D=x # trailing',
          'E=',
          'not a line',
        ].join('\n'),
      ),
      expected: {
        A: '1',
        B: 'two words',
        C: '!gh auth git-credential',
        D: 'x',
        E: '',
      },
    });
  });
});

describe('assessAgentEnv', () => {
  test('accepts the committed example once the token is filled in', () => {
    assert({
      given: '.env.agent.example with a token',
      should: 'pass',
      actual: assessAgentEnv(parseDotenv(filled)),
      expected: [],
    });
  });

  test('refuses an agent environment that would fall back to the owner', () => {
    assert({
      given: 'the example as committed, with no token',
      should: 'refuse because gh would use the owner keyring token',
      actual: assessAgentEnv(parseDotenv(example)),
      expected: [
        'GH_TOKEN is empty: gh and git would fall back to the owner keyring token',
      ],
    });
    assert({
      given: 'an env file without the autonomous marker or HTTPS rewrite',
      should: 'name every missing safeguard',
      actual: assessAgentEnv({ GH_TOKEN: 't' }),
      expected: [
        'AGENT_AUTONOMOUS must be 1',
        'GIT_CONFIG_* must rewrite git@github.com: to HTTPS',
        'GIT_CONFIG_* must use `gh auth git-credential` as the GitHub credential helper',
        'GIT_SSH_COMMAND must refuse SSH so the owner key is never used',
      ],
    });
  });
});

describe('assessGithubIdentity', () => {
  const agent = {
    autonomous: true,
    login: 'offense-demo-agent',
    tokenFromEnv: true,
    pushUrl: 'https://github.com/2witstudios/offense-demo.git',
    credentialHelper: '!gh auth git-credential',
    owner: '2witstudios',
  };

  test('passes an autonomous session under the machine identity', () => {
    assert({
      given: 'an agent session using the agent token over HTTPS',
      should: 'pass and name the identity',
      actual: assessGithubIdentity(agent),
      expected: {
        status: 'pass',
        detail: 'autonomous as offense-demo-agent (GH_TOKEN, HTTPS push)',
      },
    });
  });

  test('fails an autonomous session that resolves to the owner', () => {
    assert({
      given: 'AGENT_AUTONOMOUS=1 authenticated as the owner',
      should: 'fail',
      actual: assessGithubIdentity({ ...agent, login: '2witstudios' }).status,
      expected: 'fail',
    });
    assert({
      given: 'an autonomous session using the keyring or an SSH remote',
      should: 'fail for each fallback',
      actual: [
        assessGithubIdentity({ ...agent, tokenFromEnv: false }).status,
        assessGithubIdentity({
          ...agent,
          pushUrl: 'git@github.com:2witstudios/offense-demo.git',
        }).status,
        assessGithubIdentity({ ...agent, credentialHelper: 'osxkeychain' })
          .status,
        assessGithubIdentity({ ...agent, login: undefined }).status,
      ],
      expected: ['fail', 'fail', 'fail', 'fail'],
    });
  });

  test('reports the owner session without failing it', () => {
    assert({
      given: 'an owner session on the keyring token',
      should: 'pass and report the identity',
      actual: assessGithubIdentity({
        ...agent,
        autonomous: false,
        login: '2witstudios',
        tokenFromEnv: false,
      }),
      expected: { status: 'pass', detail: 'owner session as 2witstudios' },
    });
  });
});

describe('agent launcher', () => {
  const launch = (
    envFile: string | undefined,
    inherited: Record<string, string> = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'grd-6-launch-'));
    if (envFile !== undefined) writeFileSync(join(dir, '.env.agent'), envFile);
    const base = { ...process.env };
    delete base.GH_TOKEN;
    delete base.AGENT_AUTONOMOUS;
    delete base.PU_PROJECT_ROOT;
    const run = Bun.spawnSync(
      ['sh', `${root}/scripts/agent-launch.sh`, 'sh', '-c', 'env'],
      { cwd: dir, env: { ...base, ...inherited }, stderr: 'pipe' },
    );
    return Object.assign(run, { dir });
  };

  test('exports the machine identity into the agent process', () => {
    const run = launch(filled);
    const env = parseDotenv(run.stdout.toString());
    assert({
      given: 'a worktree holding a filled .env.agent',
      should: 'start the agent with the agent token and HTTPS pushes',
      actual: [
        run.exitCode,
        env.GH_TOKEN,
        env.AGENT_AUTONOMOUS,
        env.GIT_CONFIG_VALUE_3,
      ],
      expected: [0, 'agent-token-value', '1', '!gh auth git-credential'],
    });
  });

  test("drops the owner's inherited GitHub tokens and SSH agent", () => {
    const run = launch(filled, {
      GITHUB_TOKEN: 'owner-token',
      GH_ENTERPRISE_TOKEN: 'owner-enterprise',
      SSH_AUTH_SOCK: '/tmp/owner-agent.sock',
    });
    const env = parseDotenv(run.stdout.toString());
    assert({
      given: 'a login environment carrying the owner credentials',
      should: 'start the agent without them',
      actual: [
        run.exitCode,
        env.GITHUB_TOKEN,
        env.GH_ENTERPRISE_TOKEN,
        env.SSH_AUTH_SOCK,
      ],
      expected: [0, undefined, undefined, undefined],
    });
  });

  test('refuses values the shell would expand instead of passing them through', () => {
    const expanding = [
      filled.replace('GH_TOKEN=agent-token-value', 'GH_TOKEN=${GITHUB_TOKEN}'),
      filled.replace('GH_TOKEN=agent-token-value', 'GH_TOKEN="${NOPE:-}"'),
      filled.replace('GH_TOKEN=agent-token-value', 'GH_TOKEN=$(printf x)'),
      filled.replace('GH_TOKEN=agent-token-value', 'GH_TOKEN=`printf x`'),
    ].map((file) => launch(file));
    assert({
      given:
        'GH_TOKEN written as a variable, a default, and command substitutions',
      should: 'exit non-zero without starting the agent',
      actual: expanding.map((run) => [run.exitCode, run.stdout.toString()]),
      expected: Array(4).fill([1, '']),
    });
  });

  test('never runs the file as shell code', () => {
    const run = launch(
      filled.replace(
        'GH_TOKEN=agent-token-value',
        'GH_TOKEN=agent-token;touch pwned',
      ),
    );
    assert({
      given: 'a token with a command after a semicolon',
      should: 'export the value literally and run nothing from it',
      actual: [
        run.exitCode,
        parseDotenv(run.stdout.toString()).GH_TOKEN,
        existsSync(join(run.dir, 'pwned')),
      ],
      expected: [0, 'agent-token;touch pwned', false],
    });
  });

  test('refuses to start an agent whose identity file is invalid', () => {
    const empty = launch(example);
    assert({
      given: 'an .env.agent with an empty token',
      should: 'exit non-zero without starting the agent',
      actual: [empty.exitCode, empty.stdout.toString()],
      expected: [1, ''],
    });
  });

  test('starts the agent as before, with a warning, while the regime is off', () => {
    const run = launch(undefined);
    const env = parseDotenv(run.stdout.toString());
    assert({
      given:
        'no .env.agent in the project root or the worktree (before GRD-6.2)',
      should: 'start the agent without an identity and say so',
      actual: [
        run.exitCode,
        env.AGENT_AUTONOMOUS,
        run.stderr.toString().includes('identity regime not active'),
      ],
      expected: [0, undefined, true],
    });
  });

  test('prefers the owner file in the project root to the worktree copy', () => {
    const project = mkdtempSync(join(tmpdir(), 'grd-6-project-'));
    writeFileSync(join(project, '.env.agent'), filled);
    const run = launch(example, { PU_PROJECT_ROOT: project });
    assert({
      given: 'a valid owner file and an emptied worktree copy',
      should: "start with the owner file's identity",
      actual: [run.exitCode, parseDotenv(run.stdout.toString()).GH_TOKEN],
      expected: [0, 'agent-token-value'],
    });
  });

  test('fails closed once the regime is active and the owner identity cannot be loaded', () => {
    const invalid = mkdtempSync(join(tmpdir(), 'grd-6-project-'));
    writeFileSync(join(invalid, '.env.agent'), example);
    const unreadable = mkdtempSync(join(tmpdir(), 'grd-6-project-'));
    writeFileSync(join(unreadable, '.env.agent'), filled);
    chmodSync(join(unreadable, '.env.agent'), 0o000);
    const runs = [
      launch(filled, { PU_PROJECT_ROOT: invalid }),
      launch(filled, { PU_PROJECT_ROOT: unreadable }),
    ];
    assert({
      given:
        'an owner .env.agent with an empty token, and one the launcher cannot read, each beside a valid worktree copy',
      should:
        'refuse to start the agent, never falling back to the worktree copy or to the owner',
      actual: runs.map((run) => [run.exitCode !== 0, run.stdout.toString()]),
      expected: [
        [true, ''],
        [true, ''],
      ],
    });
  });

  test('starts a terminal agent as a login shell under the identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grd-6-launch-'));
    writeFileSync(join(dir, '.env.agent'), filled);
    const base = { ...process.env };
    delete base.GH_TOKEN;
    delete base.PU_PROJECT_ROOT;
    const run = Bun.spawnSync(
      ['sh', `${root}/scripts/agent-launch.sh`, 'shell'],
      {
        cwd: dir,
        env: { ...base, SHELL: '/bin/sh' },
        stdin: Buffer.from('echo "token=$GH_TOKEN"\n'),
        stderr: 'pipe',
      },
    );
    assert({
      given: 'the terminal agent type (pu passes shell)',
      should: 'run $SHELL -l with the identity exported',
      actual: run.stdout.toString().includes('token=agent-token-value'),
      expected: true,
    });
  });
});

describe('identityRegime', () => {
  const project = '/repo';
  const exists = (files: string[]) => (path: string) => files.includes(path);
  const agentEnv = {
    PU_PROJECT_ROOT: project,
    PU_AGENT_ID: 'ag-1',
    GH_TOKEN: 't',
    AGENT_AUTONOMOUS: '1',
  };

  test("is active only when the owner's .env.agent exists in the project root", () => {
    assert({
      given:
        'no owner file (the worktree copy alone), and the owner file with a proper agent',
      should: 'be inactive, then agent',
      actual: [
        identityRegime(
          agentEnv,
          exists(['/repo/.pu/worktrees/wt-1/.env.agent']),
        ),
        identityRegime(agentEnv, exists(['/repo/.env.agent'])),
      ],
      expected: ['inactive', 'agent'],
    });
  });

  test('flags a pu agent that runs without its identity, whatever its worktree holds', () => {
    const owner = exists(['/repo/.env.agent']);
    assert({
      given:
        'a resumed agent missing GH_TOKEN, one missing AGENT_AUTONOMOUS, and an owner session',
      should: 'be misconfigured twice, and owner',
      actual: [
        identityRegime({ ...agentEnv, GH_TOKEN: undefined }, owner),
        identityRegime({ ...agentEnv, AGENT_AUTONOMOUS: undefined }, owner),
        identityRegime({ PU_PROJECT_ROOT: undefined }, owner, project),
      ],
      expected: ['misconfigured', 'misconfigured', 'owner'],
    });
  });

  test('turns the regime into a doctor check that fails or warns', () => {
    assert({
      given: 'each regime',
      should: 'fail when misconfigured, warn when inactive, pass otherwise',
      actual: [
        regimeCheck('misconfigured', 'ag-1').status,
        regimeCheck('inactive', undefined),
        regimeCheck('agent', 'ag-1').status,
        regimeCheck('owner', undefined).status,
      ],
      expected: [
        'fail',
        {
          status: 'warn',
          detail:
            'identity regime not active: pu agents act as the owner (GRD-6.2)',
        },
        'pass',
        'pass',
      ],
    });
  });
});

describe('exportScript', () => {
  test('exports only identity keys, single-quoted so the shell expands nothing', () => {
    assert({
      given: 'values holding a quote and $(…), and a key that is not identity',
      should: 'quote each value literally and drop the other key',
      actual: exportScript({
        GH_TOKEN: "to'ken$(id)",
        AGENT_AUTONOMOUS: '1',
        EDITOR: 'vim',
      }),
      expected: [
        "export GH_TOKEN='to'\\''ken$(id)'",
        "export AGENT_AUTONOMOUS='1'",
      ].join('\n'),
    });
  });
});

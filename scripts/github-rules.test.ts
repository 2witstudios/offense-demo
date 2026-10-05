import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  applyRefusal,
  desiredRuleset,
  diffValues,
  ghFailure,
  planRules,
  renderRepositoryConfig,
  type RepositoryPolicy,
} from './github-rules';
import { loadProjectConfig } from './project-config';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname;
const policy = (await Bun.file(
  `${root}policy/github/repository.json`,
).json()) as RepositoryPolicy;
const project = loadProjectConfig(root);
const config = renderRepositoryConfig(policy, project);

const ruleTypes = (ruleset: { rules: { type: string }[] }) =>
  ruleset.rules.map((rule) => rule.type);

describe('the committed main ruleset', () => {
  const ruleset = desiredRuleset(config, 424242);

  test('requires pull requests and forbids force-push and deletion', () => {
    assert({
      given: 'policy/github/repository.json',
      should: 'target the default branch with the four protective rules',
      actual: [
        ruleset.enforcement,
        ruleset.conditions.ref_name.include,
        ruleTypes(ruleset),
      ],
      expected: [
        'active',
        ['~DEFAULT_BRANCH'],
        [
          'deletion',
          'non_fast_forward',
          'pull_request',
          'required_status_checks',
        ],
      ],
    });
  });

  test('requires the CI gate from Actions and review-record from the review App', () => {
    const checks = ruleset.rules.find(
      (rule) => rule.type === 'required_status_checks',
    )?.parameters?.required_status_checks;
    assert({
      given: 'the review App id read from the repository',
      should: 'pin each required check to its only legitimate source',
      actual: checks,
      expected: [
        { context: 'CI gate', integration_id: 15368 },
        { context: 'Playwright E2E', integration_id: 15368 },
        { context: 'review-record', integration_id: 424242 },
      ],
    });
  });

  test('lists only the owner as bypass actor, enables auto-merge and branch deletion, and allows merge commits only', () => {
    assert({
      given: 'the committed settings',
      should:
        'let the repository admin role bypass only through pull requests (no direct push to main, the owner included), turn both settings on, and pin merge commits as the only merge method',
      actual: [ruleset.bypass_actors, config.settings],
      expected: [
        [
          {
            actor_id: 5,
            actor_type: 'RepositoryRole',
            bypass_mode: 'pull_request',
          },
        ],
        {
          allow_auto_merge: true,
          delete_branch_on_merge: true,
          allow_merge_commit: true,
          allow_squash_merge: false,
          allow_rebase_merge: false,
        },
      ],
    });
  });
});

describe('renderRepositoryConfig', () => {
  test('takes identity and required check names from project config', () => {
    const rendered = renderRepositoryConfig(policy, {
      repo: 'example/app',
      owner: 'example',
      gates: { integrationCommand: 'x', requiredChecks: ['Build'] },
    });
    assert({
      given: 'a project config naming its repo, owner and one required check',
      should:
        'render that identity and the check pinned to Actions, plus review-record',
      actual: [
        rendered.repository,
        rendered.owner,
        rendered.ruleset.rules.find(
          (rule) => rule.type === 'required_status_checks',
        )?.parameters?.required_status_checks,
      ],
      expected: [
        'example/app',
        'example',
        [
          { context: 'Build', integration_id: 15368 },
          {
            context: 'review-record',
            integration_id: 'vars.REVIEW_RECORD_APP_ID',
          },
        ],
      ],
    });
  });

  test('refuses a policy that duplicates the required checks', () => {
    const duplicated: RepositoryPolicy = {
      ...policy,
      ruleset: {
        ...policy.ruleset,
        rules: policy.ruleset.rules.map((rule) =>
          rule.type === 'required_status_checks'
            ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_status_checks: [
                    { context: 'CI gate', integration_id: 15368 },
                  ],
                },
              }
            : rule,
        ),
      },
    };
    let message = 'no throw';
    try {
      renderRepositoryConfig(duplicated, project);
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a policy file that lists required_status_checks itself',
      should: 'refuse, naming project.config.json as the source',
      actual: message,
      expected:
        'policy/github/repository.json must not list required_status_checks; they come from project.config.json gates.requiredChecks',
    });
  });

  test('every configured required check is a job some workflow runs', async () => {
    const names = new Set<string>();
    for await (const file of new Bun.Glob('.github/workflows/*.yml').scan(root))
      for (const [, name] of (await Bun.file(`${root}${file}`).text()).matchAll(
        /^ {4}name: (.+)$/gm,
      ))
        names.add(name.trim());
    assert({
      given: 'project.config.json gates.requiredChecks and the workflows',
      should: 'name only checks a workflow job actually reports',
      actual: project.gates.requiredChecks.filter((check) => !names.has(check)),
      expected: [],
    });
  });

  test('the committed policy names no repository or owner', () => {
    assert({
      given: 'policy/github/repository.json',
      should: 'leave identity to project.config.json',
      actual: ['repository', 'owner'].filter((key) => key in policy),
      expected: [],
    });
  });
});

describe('diffValues', () => {
  test('lists changed, added and removed leaves by path', () => {
    assert({
      given: 'live and desired values',
      should: 'describe each difference',
      actual: diffValues(
        { a: 1, b: { c: [1, 2] }, d: 'x' },
        { a: 2, b: { c: [1] }, e: true },
      ),
      expected: ['~ a: 1 → 2', '- b.c[1]: 2', '- d: "x"', '+ e: true'],
    });
  });
});

describe('planRules', () => {
  // Live today: every merge method on, auto-merge and branch deletion off.
  const liveSettings = {
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
  };

  test('plans creating the ruleset and fixing settings on a bare repository', () => {
    const plan = planRules({
      config,
      appId: 424242,
      live: { ruleset: undefined, settings: liveSettings },
    });
    assert({
      given: 'no ruleset, both settings off and squash and rebase allowed',
      should: 'plan a create and a settings patch, with the diff',
      actual: [
        plan.actions,
        plan.changes.filter((line) => line.startsWith('~ settings')),
      ],
      expected: [
        ['create ruleset main', 'patch settings'],
        [
          '~ settings.allow_auto_merge: false → true',
          '~ settings.delete_branch_on_merge: false → true',
          '~ settings.allow_squash_merge: true → false',
          '~ settings.allow_rebase_merge: true → false',
        ],
      ],
    });
  });

  test('plans nothing when live GitHub matches', () => {
    const plan = planRules({
      config,
      appId: 424242,
      live: {
        ruleset: { id: 9, ...desiredRuleset(config, 424242) },
        settings: config.settings,
      },
    });
    assert({
      given: 'a live ruleset and settings equal to the committed ones',
      should: 'report no changes',
      actual: [plan.actions, plan.changes],
      expected: [[], []],
    });
  });
});

describe('ghFailure', () => {
  test("includes gh's own stderr reason, or omits it when gh gave none", () => {
    assert({
      given: 'a failed gh call with a reason on stderr, and one with none',
      should: 'name the command and, when present, the reason',
      actual: [
        ghFailure(
          ['api', '-X', 'PATCH', 'repos/2witstudios/offense-demo'],
          'HTTP 403: Resource not accessible by integration\n',
        ),
        ghFailure(['api', 'repos/2witstudios/offense-demo/rulesets'], ''),
      ],
      expected: [
        'gh api -X PATCH repos/2witstudios/offense-demo failed: HTTP 403: Resource not accessible by integration',
        'gh api repos/2witstudios/offense-demo/rulesets failed',
      ],
    });
  });
});

describe('applyRefusal', () => {
  const ok = {
    autonomous: false,
    login: '2witstudios',
    owner: '2witstudios',
    appId: 1,
  };

  test('lets only the owner apply, and only with the review App known', () => {
    assert({
      given: 'the owner, an agent, another login, and a missing App id',
      should: 'allow the owner and refuse the rest',
      actual: [
        applyRefusal(ok),
        applyRefusal({ ...ok, autonomous: true }),
        applyRefusal({ ...ok, login: 'offense-demo-agent' }),
        applyRefusal({ ...ok, appId: undefined }),
      ].map((refusal) => refusal === undefined),
      expected: [true, false, false, false],
    });
  });
});

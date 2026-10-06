import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  renderRepositoryConfig,
  rulesetsNeedUpgrade,
  rulesetsUnavailableMessage,
  runGithubRules,
  type Gh,
  type GhResult,
  type RepositoryPolicy,
} from './github-rules';
import { loadProjectConfig } from './project-config';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname;
const config = renderRepositoryConfig(
  (await Bun.file(
    `${root}policy/github/repository.json`,
  ).json()) as RepositoryPolicy,
  loadProjectConfig(root),
);

describe('runGithubRules', () => {
  const UPGRADE =
    'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n';
  const repo = `repos/${config.repository}`;
  const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
  const denied: GhResult = { code: 1, stdout: '', stderr: UPGRADE };

  /** A fake gh: answers by joined args; records every call. */
  const fakeGh = (answers: Readonly<Record<string, GhResult>>) => {
    const calls: string[] = [];
    const gh: Gh = (args) => {
      const line = args.join(' ');
      calls.push(line);
      const exact = answers[line];
      if (exact) return exact;
      const prefix = Object.keys(answers).find((key) => line.startsWith(key));
      return prefix
        ? (answers[prefix] as GhResult)
        : { code: 1, stdout: '', stderr: `unexpected: ${line}` };
    };
    return { gh, calls };
  };

  const run = (gh: Gh, apply: boolean) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runGithubRules({
      config,
      gh,
      apply,
      autonomous: false,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join('') };
  };

  const bareRepo = {
    [`api ${repo}/rulesets`]: ok('[]'),
    [`api ${repo}/actions/variables/REVIEW_RECORD_APP_ID --jq .value`]:
      ok('424242\n'),
    [`api ${repo}`]: ok(JSON.stringify({ allow_auto_merge: false })),
    'api user --jq .login': ok(`${config.owner}\n`),
    'api user --jq .plan.name': ok('free\n'),
  };

  test('fails clearly when GitHub refuses to create the ruleset on a private free repository', () => {
    const { gh, calls } = fakeGh({
      [`api -X POST ${repo}/rulesets`]: denied,
      ...bareRepo,
    });
    const result = run(gh, true);
    assert({
      given: '--apply and a 403 "Upgrade to GitHub Pro" on the ruleset POST',
      should:
        'exit 1, name the plan and the one-line fix, and never patch settings or claim success',
      actual: [
        result.code,
        result.err.includes('(your GitHub plan: free)'),
        result.err.includes(
          `gh repo edit ${config.repository} --visibility public --accept-visibility-change-consequences`,
        ),
        result.out.includes('applied'),
        calls.some((call) => call.startsWith('api -X PATCH')),
      ],
      expected: [1, true, true, false, false],
    });
  });

  test('fails clearly when the ruleset list itself is refused', () => {
    const { gh } = fakeGh({ ...bareRepo, [`api ${repo}/rulesets`]: denied });
    const result = run(gh, false);
    assert({
      given: 'a dry run on a repository whose rulesets endpoint answers 403',
      should: 'exit 1 with the explanation instead of a raw gh error',
      actual: [result.code, result.err.includes('NOT enforced')],
      expected: [1, true],
    });
  });

  test('applies on a repository that supports rulesets', () => {
    const { gh, calls } = fakeGh({
      [`api -X POST ${repo}/rulesets`]: ok('{}'),
      [`api -X PATCH ${repo}`]: ok('{}'),
      ...bareRepo,
    });
    const result = run(gh, true);
    assert({
      given: '--apply on a bare repository where GitHub accepts the ruleset',
      should: 'create the ruleset, patch the settings and report it',
      actual: [
        result.code,
        result.out.includes('applied: create ruleset main, patch settings'),
        calls.filter((call) => call.startsWith('api -X')).length,
      ],
      expected: [0, true, 2],
    });
  });

  test('rethrows any other gh failure', () => {
    const { gh } = fakeGh({
      ...bareRepo,
      [`api ${repo}/rulesets`]: {
        code: 1,
        stdout: '',
        stderr: 'HTTP 404: Not Found',
      },
    });
    let message = 'no throw';
    try {
      run(gh, false);
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a 404 from the rulesets endpoint',
      should: 'surface gh failure as before',
      actual: message,
      expected: `gh api ${repo}/rulesets failed: HTTP 404: Not Found`,
    });
  });
});

describe('rulesetsNeedUpgrade', () => {
  test("recognises GitHub's paid-feature refusal only", () => {
    assert({
      given: 'the Pro upgrade 403, a Team upgrade 403 and an unrelated 403',
      should: 'match the first two',
      actual: [
        rulesetsNeedUpgrade(
          'Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
        ),
        rulesetsNeedUpgrade('Upgrade to GitHub Team to enable this feature.'),
        rulesetsNeedUpgrade('HTTP 403: Resource not accessible by integration'),
      ],
      expected: [true, true, false],
    });
  });

  test('the message says nothing was applied, even with no known plan', () => {
    assert({
      given: 'an unknown plan',
      should: 'say so and still give the fix',
      actual: rulesetsUnavailableMessage('o/r', undefined).split('\n')[0],
      expected:
        'Branch rulesets are not available on o/r: GitHub enforces them only on public repositories or on a paid plan (your GitHub plan: unknown).',
    });
  });
});

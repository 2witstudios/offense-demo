import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { resolve } from 'node:path';
import {
  collectWorkflowHardeningProblems,
  workflowHardeningProblems,
} from './workflow-hardening';

setupRitewayBun();

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const workflow = (steps: string, jobEnv = '', workflowEnv = '') =>
  [
    'name: Fixture',
    'on: push',
    workflowEnv,
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-24.04',
    jobEnv,
    '    steps:',
    steps,
  ]
    .filter((line) => line !== '')
    .join('\n');

describe('action pinning', () => {
  test('accepts SHA pins with a version comment, local actions and docker images', () => {
    assert({
      given:
        'a SHA-pinned action, a SHA-pinned sub-path action, a local action and a docker image',
      should: 'report nothing',
      actual: workflowHardeningProblems(
        'ok.yml',
        workflow(
          [
            `      - uses: actions/checkout@${SHA} # v7.0.1`,
            `      - uses: superfly/flyctl-actions/setup-flyctl@${SHA} # 1.6`,
            '      - uses: ./.github/actions/local',
            '      - uses: docker://alpine:3.22',
          ].join('\n'),
        ),
      ),
      expected: [],
    });
  });

  test('rejects a tag, a branch, a short SHA and a SHA without its version comment', () => {
    assert({
      given: 'four references Dependabot or a reviewer cannot trust',
      should: 'name each one with its file and line',
      actual: workflowHardeningProblems(
        'bad.yml',
        workflow(
          [
            '      - uses: actions/checkout@v7',
            '      - name: Branch',
            '        uses: oven-sh/setup-bun@main',
            '      - uses: actions/checkout@3d3c42e',
            `      - uses: actions/checkout@${SHA}`,
          ].join('\n'),
        ),
      ),
      expected: [
        'bad.yml:7: action is not pinned to a full commit SHA with a version comment: actions/checkout@v7',
        'bad.yml:9: action is not pinned to a full commit SHA with a version comment: oven-sh/setup-bun@main',
        'bad.yml:10: action is not pinned to a full commit SHA with a version comment: actions/checkout@3d3c42e',
        `bad.yml:11: action is not pinned to a full commit SHA with a version comment: actions/checkout@${SHA}`,
      ],
    });
  });
});

describe('secret scope', () => {
  const step = [
    `      - uses: actions/checkout@${SHA} # v7.0.1`,
    '      - run: deploy',
    '        env:',
    '          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}',
    '          GH_TOKEN: ${{ github.token }}',
  ].join('\n');

  test('accepts credentials exposed only on the step that uses them', () => {
    assert({
      given: 'a secret and the GitHub token in one step env',
      should: 'report nothing',
      actual: workflowHardeningProblems('ok.yml', workflow(step)),
      expected: [],
    });
  });

  test('rejects credentials at job or workflow scope and inherited secrets', () => {
    const jobEnv = [
      '    env:',
      '      FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}',
      '      GH_TOKEN: ${{ github.token }}',
      '      APP_VERSION: ci',
    ].join('\n');
    const workflowEnv = [
      'env:',
      '  PAGESPACE_TOKEN: ${{ secrets.PAGESPACE_TOKEN }}',
    ].join('\n');
    const inherit = [
      'name: Caller',
      'on: push',
      'jobs:',
      '  call:',
      '    uses: ./.github/workflows/called.yml',
      '    secrets: inherit',
    ].join('\n');
    assert({
      given:
        'a workflow-level secret, a job-level secret and token, and a caller passing secrets: inherit',
      should: 'name each broad exposure and leave plain job env alone',
      actual: [
        ...workflowHardeningProblems(
          'broad.yml',
          workflow(step, jobEnv, workflowEnv),
        ),
        ...workflowHardeningProblems('caller.yml', inherit),
      ],
      expected: [
        'broad.yml: workflow env PAGESPACE_TOKEN holds a credential; scope it to the step that uses it',
        'broad.yml: job build env FLY_API_TOKEN holds a credential; scope it to the step that uses it',
        'broad.yml: job build env GH_TOKEN holds a credential; scope it to the step that uses it',
        'caller.yml: job call passes secrets: inherit',
      ],
    });
  });
});

describe('the repository workflows', () => {
  test('pin every action to a SHA and scope every secret to its step', () => {
    assert({
      given: 'every workflow under .github/workflows',
      should: 'have no hardening problem',
      actual: collectWorkflowHardeningProblems(resolve(import.meta.dir, '..')),
      expected: [],
    });
  });
});

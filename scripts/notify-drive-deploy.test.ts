import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { composeDeployFailureMessage, firstFailedStep } from './notify-drive';

setupRitewayBun();

describe('firstFailedStep', async () => {
  test('names the first failed step across the deploy jobs', async () => {
    assert({
      given:
        'step outcomes from the ready and deploy jobs with the readiness probe failed',
      should: 'return the job and step id of the failure',
      actual: firstFailedStep(
        'ready.checkout=success ready.setup-bun=success ready.decide=success deploy.checkout=success deploy.setup-flyctl=success deploy.deploy=success deploy.readiness=failure',
      ),
      expected: 'deploy.readiness',
    });
  });

  test('reads outcomes from a job that never ran as blanks', async () => {
    assert({
      given:
        'a manual dispatch: the skipped ready job leaves blank outcomes, and the deploy step failed',
      should: 'skip the blanks and name the deploy step',
      actual: firstFailedStep(
        'ready.checkout= ready.setup-bun= ready.decide= deploy.checkout=success deploy.setup-flyctl=success deploy.deploy=failure deploy.readiness=skipped',
      ),
      expected: 'deploy.deploy',
    });
  });

  test('never echoes a value that is not a step id and outcome', async () => {
    assert({
      given:
        'outcomes carrying a connection URL, a token-shaped pair and no failure',
      should: 'ignore every malformed pair and report the step as unknown',
      actual: firstFailedStep(
        'postgres://offense_demo:hunter2@db.internal:5432/offense_demo=failure deploy.token=ghp_abc123 deploy.deploy=success',
      ),
      expected: 'unknown',
    });
  });
});

describe('composeDeployFailureMessage', async () => {
  test('renders the failed staging deploy', async () => {
    assert({
      given: 'a failed staging deploy',
      should:
        'compose a message with the app, run link, failing step and commit',
      actual: composeDeployFailureMessage({
        app: 'offense-demo-staging',
        step: 'deploy.readiness',
        sha: 'abc1234',
        runUrl: 'https://ci.test/run/2',
      }),
      expected:
        '🔴 Deploy failed — offense-demo-staging\nhttps://ci.test/run/2\nFailing step: deploy.readiness\ncommit abc1234',
    });
  });
});

type WorkflowStep = {
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
};
type WorkflowJob = {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly env?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps: readonly WorkflowStep[];
};

describe('deploy-staging failure notification', async () => {
  const deployStaging = Bun.YAML.parse(
    await Bun.file(
      new URL('../.github/workflows/deploy-staging.yml', import.meta.url),
    ).text(),
  ) as { jobs: Record<string, WorkflowJob> };
  const { ready, deploy, 'notify-drive': notify } = deployStaging.jobs;
  const outcomesOf = (job: string, { steps, outputs }: WorkflowJob) => ({
    ids: steps.map((step) => step.id),
    reported: [
      ...(outputs?.outcomes ?? '').matchAll(
        /(\S+)=\$\{\{ steps\.(\S+)\.outcome \}\}/g,
      ),
    ].map(([, label, id]) => (label === `${job}.${id}` ? id : `!${label}`)),
  });

  test('reports every step of both jobs by id', async () => {
    assert({
      given: 'the ready and deploy jobs',
      should:
        'give every step an id and publish each outcome as <job>.<id>, so no failing step goes unnamed',
      actual: [outcomesOf('ready', ready), outcomesOf('deploy', deploy)].map(
        ({ ids, reported }) => ({ ids, reported }),
      ),
      expected: [
        outcomesOf('ready', ready).ids,
        outcomesOf('deploy', deploy).ids,
      ].map((ids) => ({ ids, reported: ids })),
    });
  });

  test('posts to Incidents on failure with the webhook secret on the posting step only', async () => {
    const posting = notify.steps.find((step) =>
      (step.run ?? '').includes('notify-drive.ts incidents'),
    );
    const allEnv = JSON.stringify([
      notify.env ?? {},
      ...notify.steps.map((step) => step.env ?? {}),
    ]);
    assert({
      given: 'the notify-drive job of deploy-staging.yml',
      should:
        'run after a failure of either job, post the deploy command with sha, run URL and outcomes, and hold no deploy or database credential',
      actual: {
        needs: [notify.needs].flat(),
        if: notify.if,
        jobEnv: notify.env,
        secretSteps: notify.steps
          .filter((step) =>
            Object.values(step.env ?? {}).some((value) =>
              value.includes('secrets.'),
            ),
          )
          .map((step) =>
            Object.keys(step.env ?? {}).filter((key) =>
              key.startsWith('PAGESPACE_'),
            ),
          ),
        command: posting?.run?.replace(/\s+/g, ' '),
        outcomes: posting?.env?.NOTIFY_OUTCOMES,
        forbidden: /FLY_API_TOKEN|DATABASE_URL|REDIS_URL/.test(allEnv),
      },
      expected: {
        needs: ['ready', 'deploy'],
        if: 'failure()',
        jobEnv: undefined,
        secretSteps: [
          [
            'PAGESPACE_INCIDENTS_WEBHOOK_URL',
            'PAGESPACE_INCIDENTS_WEBHOOK_SECRET',
          ],
        ],
        command:
          'bun scripts/notify-drive.ts incidents --deploy offense-demo-staging --sha "$NOTIFY_SHA" --run-url "$NOTIFY_RUN_URL" --outcomes "$NOTIFY_OUTCOMES"',
        outcomes:
          '${{ needs.ready.outputs.outcomes }} ${{ needs.deploy.outputs.outcomes }}',
        forbidden: false,
      },
    });
  });
});

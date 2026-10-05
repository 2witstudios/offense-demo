import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { reviewAppGate } from './review-record';

setupRitewayBun();

type Step = {
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Record<string, string>;
};
type Job = {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | string[];
  readonly environment?: string;
  readonly outputs?: Record<string, string>;
  readonly steps: readonly Step[];
};
const workflow = Bun.YAML.parse(
  await Bun.file(
    new URL('../.github/workflows/review-record.yml', import.meta.url),
  ).text(),
) as { jobs: Record<string, Job> };

describe('review-record before and after the App exists', () => {
  test('skips with a notice until the App id and key are configured, and enforces once they are', () => {
    assert({
      given: 'no App id or key, an id without its key, and both (GRD-6.2 done)',
      should:
        'report not configured with the notice for the first two, and enforce for the last',
      actual: [
        reviewAppGate({}),
        reviewAppGate({ REVIEW_RECORD_APP_ID: '424242' }),
        reviewAppGate({
          REVIEW_RECORD_APP_ID: '424242',
          REVIEW_RECORD_APP_KEY: 'key',
        }),
      ],
      expected: [
        {
          state: 'not-configured',
          notice: 'review App not configured (GRD-6.2)',
        },
        {
          state: 'not-configured',
          notice: 'review App not configured (GRD-6.2)',
        },
        { state: 'enforce', notice: undefined },
      ],
    });
  });

  test('wires the gate so verification runs only when enforcing, and the gate never sets a status', () => {
    const { gate, verify } = workflow.jobs;
    const gateCommands = gate.steps.map((step) => step.run ?? '').join('\n');
    assert({
      given: 'the review-record workflow',
      should:
        'read the key in the main-only environment, skip verify unless the gate enforces, and keep status writes out of the gate',
      actual: {
        gateEnvironment: gate.environment,
        gateReadsSecret: gate.steps.some((step) =>
          Object.values(step.env ?? {}).some((value) =>
            value.includes('secrets.REVIEW_RECORD_APP_KEY'),
          ),
        ),
        verifyNeedsGate: [verify.needs].flat().includes('gate'),
        verifyOnlyWhenEnforcing: (verify.if ?? '').includes(
          "needs.gate.outputs.state == 'enforce'",
        ),
        gateWritesStatus: /statuses|create-github-app-token/.test(
          gateCommands + gate.steps.map((step) => step.uses ?? '').join('\n'),
        ),
      },
      expected: {
        gateEnvironment: 'review-record',
        gateReadsSecret: true,
        verifyNeedsGate: true,
        verifyOnlyWhenEnforcing: true,
        gateWritesStatus: false,
      },
    });
  });
});

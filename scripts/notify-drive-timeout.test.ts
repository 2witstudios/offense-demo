import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { postToDrive } from './notify-drive';

setupRitewayBun();

/** A webhook that accepts the request and never answers it until aborted. */
const hungFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new Error('The operation timed out.')),
    );
  })) as typeof fetch;

describe('postToDrive bounds each delivery attempt (ISSUE-208)', () => {
  test('a webhook that never answers fails after its attempts instead of hanging', async () => {
    const started = performance.now();
    const error = await postToDrive(
      'incidents',
      'probe message',
      {
        fetchImpl: hungFetch,
        attemptTimeoutMs: 100,
        delays: [0, 0],
        delay: async () => {},
      },
      {
        PAGESPACE_INCIDENTS_WEBHOOK_URL: 'https://incidents.example.test/hook',
        PAGESPACE_INCIDENTS_WEBHOOK_SECRET: 'secret',
      },
    ).then(
      () => undefined,
      (failure: Error) => failure.message,
    );
    assert({
      given:
        'an Incidents webhook that never answers, a 100 ms attempt budget and two retries',
      should:
        'reject naming the timed-out request once every attempt has run out, within a second',
      actual: {
        rejected: error?.includes('Webhook incidents request failed') ?? false,
        withinBudget: performance.now() - started < 1000,
      },
      expected: { rejected: true, withinBudget: true },
    });
  });
});

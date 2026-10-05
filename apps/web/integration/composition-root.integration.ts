import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { createTestApp } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();
requireTestServices(process.env);

/**
 * ISSUE-7: two apps built by `createApp` side by side in one process, over
 * the same PostgreSQL and Redis, with different environments. Each request
 * is answered from its own app's configuration, limiter namespace and
 * mailbox, and building them touches no process-wide state.
 */
const envBefore = JSON.stringify(process.env);
const globalsBefore = Object.keys(globalThis).sort();

const firstToken = `ops-${createId()}${createId()}`;
const secondToken = `ops-${createId()}${createId()}`;
const first = createTestApp({ OPS_PROBE_TOKEN: firstToken });
const second = createTestApp({ OPS_PROBE_TOKEN: secondToken });

const metricsProbe = (testApp: typeof first) =>
  testApp.routes.ops.metrics.GET(
    new Request(`${testApp.origin}/api/ops/metrics`, {
      headers: { authorization: `Bearer ${firstToken}` },
    }),
  );

const magicLink = (testApp: typeof first, client: string, email: string) =>
  testApp.routes.auth.POST(
    testApp.jsonPost(
      '/api/auth/sign-in/magic-link',
      { email },
      { [CLIENT_IP_HEADER]: client },
    ),
  );

describe('ISSUE-7 composition root', () => {
  test('two apps with different config answer concurrent requests from their own config', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        metricsProbe(index % 2 === 0 ? first : second),
      ),
    );
    assert({
      given:
        "interleaved concurrent probe requests carrying the first app's token to both apps",
      should:
        'admit them on the first app every time and refuse them on the second',
      actual: responses.map((response) => response.status),
      expected: [200, 401, 200, 401, 200, 401],
    });
  });

  test("one app's rate limits and mail never reach the other", async () => {
    const client = '198.51.100.77';
    const firstBefore = first.mailbox.mails.length;
    const secondBefore = second.mailbox.mails.length;
    const email = first.freshEmail();
    const exhausted = [];
    for (let index = 0; index < 4; index += 1)
      exhausted.push((await magicLink(first, client, email)).status);
    const other = second.freshEmail();
    const fromOtherApp = (await magicLink(second, client, other)).status;
    const firstKeys = await first.redisKeys();
    const secondKeys = await second.redisKeys();
    assert({
      given:
        'one client exhausting its magic-link limit on the first app, then asking the second',
      should:
        "limit it on the first app only, keep each app's keys in its own namespace and deliver each mail to its own mailbox",
      actual: {
        exhausted,
        fromOtherApp,
        firstMails: first.mailbox.mails
          .slice(firstBefore)
          .map((mail) => mail.to === email),
        secondMails: second.mailbox.mails
          .slice(secondBefore)
          .map((mail) => mail.to === other),
        namespaces: {
          first: firstKeys.every(({ key }) =>
            key.startsWith(`${first.redisNamespace}:`),
          ),
          second: secondKeys.every(({ key }) =>
            key.startsWith(`${second.redisNamespace}:`),
          ),
          distinct: first.redisNamespace !== second.redisNamespace,
        },
      },
      expected: {
        exhausted: [200, 200, 200, 429],
        fromOtherApp: 200,
        firstMails: [true, true, true],
        secondMails: [true],
        namespaces: { first: true, second: true, distinct: true },
      },
    });
  });

  test('building and serving both apps changed no process environment or global', () => {
    assert({
      given: 'two apps built and exercised in this process',
      should: 'leave process.env and the global object exactly as they were',
      actual: {
        env: JSON.stringify(process.env) === envBefore,
        globals: Object.keys(globalThis).sort(),
      },
      expected: { env: true, globals: globalsBefore },
    });
  });
});

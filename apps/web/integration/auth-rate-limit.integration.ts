import { afterAll } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestApp, origin } from './fixtures';
import { createSecondInstances, statuses } from './auth-rate-limit-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const testApp = createTestApp();
const { mailbox, jsonPost, newClient, redisKeys, redisNamespace } = testApp;
const authRoute = testApp.routes.auth;
const { secondInstance, closeExtraInstances } = createSecondInstances(testApp);

const magicLink = (
  headers: Record<string, string> = {},
  email = testApp.freshEmail(),
) =>
  authRoute.POST(jsonPost('/api/auth/sign-in/magic-link', { email }, headers));

afterAll(async () => {
  await closeExtraInstances();
});

describe('AUTH-3.4 shared atomic rate limits through the mounted handler', () => {
  test('magic-link requests are limited to 3 per 60 seconds per client under concurrency', async () => {
    const client = newClient();
    const before = mailbox.mails.length;
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        magicLink({ [CLIENT_IP_HEADER]: client }),
      ),
    );
    const denied = responses.filter((response) => response.status === 429);
    assert({
      given: 'thirty simultaneous magic-link requests from one client',
      should:
        'admit exactly three, send exactly three messages and answer the rest 429 with retry information',
      actual: {
        tally: statuses(responses),
        mails: mailbox.mails.length - before,
        retryInfo: denied.every((response) => {
          const seconds = Number(response.headers.get('retry-after'));
          return seconds >= 1 && seconds <= 60;
        }),
      },
      expected: { tally: { 200: 3, 429: 27 }, mails: 3, retryInfo: true },
    });
  });

  test('one recipient is limited to 3 per 60 seconds even across many clients', async () => {
    const email = testApp.freshEmail();
    const before = mailbox.mails.length;
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        magicLink({ [CLIENT_IP_HEADER]: newClient() }, email),
      ),
    );
    const denied = responses.find((response) => response.status === 429);
    assert({
      given: 'twelve simultaneous requests for one address from twelve clients',
      should: 'admit exactly three and answer the rest 429 with a Retry-After',
      actual: {
        tally: statuses(responses),
        mails: mailbox.mails.length - before,
        retryAfter: Number(denied?.headers.get('retry-after')) >= 1,
      },
      expected: { tally: { 200: 3, 429: 9 }, mails: 3, retryAfter: true },
    });
  });

  test('all other auth routes share the 100 per 60 seconds default', async () => {
    const client = newClient();
    const responses = await Promise.all(
      Array.from({ length: 130 }, () =>
        authRoute.GET(
          new Request(`${origin}/api/auth/get-session`, {
            headers: { [CLIENT_IP_HEADER]: client },
          }),
        ),
      ),
    );
    assert({
      given: 'one hundred thirty simultaneous session reads from one client',
      should: 'admit exactly 100 and reject 30 with 429',
      actual: statuses(responses),
      expected: { 200: 100, 429: 30 },
    });
  });

  test('two application instances share one atomic counter', async () => {
    const a = secondInstance();
    const b = secondInstance();
    const client = newClient();
    const send = (instance: typeof a) =>
      instance.handlers.POST(
        jsonPost(
          '/api/auth/sign-in/magic-link',
          { email: testApp.freshEmail() },
          { [CLIENT_IP_HEADER]: client },
        ),
      );
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) => send(index % 2 === 0 ? a : b)),
    );
    assert({
      given:
        'forty simultaneous requests split across two instances for one client',
      should:
        'admit exactly three in total (not three per instance) and deliver exactly three',
      actual: {
        tally: statuses(responses),
        delivered: a.sent.length + b.sent.length,
      },
      expected: { tally: { 200: 3, 429: 37 }, delivered: 3 },
    });
  });

  test('keys are hashed, namespaced and always expiring', async () => {
    // Its own writes: a magic-link request fills the client, recipient and
    // global buckets; a session read fills the default bucket.
    const client = newClient();
    const email = testApp.freshEmail();
    await magicLink({ [CLIENT_IP_HEADER]: client }, email);
    await authRoute.GET(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { [CLIENT_IP_HEADER]: client },
      }),
    );
    const keys = await redisKeys();
    // The same requests also feed AUTH-7.7's per-minute auth-request
    // buckets (ISSUE-173): a bounded, identifier-free key per minute.
    const pattern = new RegExp(
      `^${redisNamespace}:v1:(rl:[0-9a-f]{64}|alert-http-(total|5xx)-[0-9]+)$`,
    );
    const [first = '', second = ''] = client.split('.');
    const identifiers = new RegExp(
      [
        `${first}\\.${second}`,
        email.replace(/[.]/g, '\\.'),
        'example\\.test',
        'sign-in',
        'magic-link',
        'session',
      ].join('|'),
    );
    assert({
      given:
        'every key this suite wrote, including its own requests: rate-limit buckets and the alert request buckets they feed',
      should:
        // The recipient and global tables above include 60 s, 1 h and 1 day
        // windows; a day is the longest TTL any bucket can carry.
        'match the namespaced digest shape, carry no identifier and have a TTL of at most one day',
      actual: {
        any: keys.length > 0,
        allMatch: keys.every(({ key }) => pattern.test(key)),
        leaksIdentifier: keys.some(({ key }) => identifiers.test(key)),
        allExpire: keys.every(({ ttlMs }) => ttlMs > 0 && ttlMs <= 86_400_000),
      },
      expected: {
        any: true,
        allMatch: true,
        leaksIdentifier: false,
        allExpire: true,
      },
    });
  });
});

// ISSUE-5 AC4's recipient-hour-ceiling and global-per-minute-ceiling tests
// live in auth-rate-limit-mail-ceilings.integration.ts (split to stay under
// this file's line limit).

describe('AUTH-3.4 outage fails closed', () => {
  test('a Redis outage answers a safe 503 for every request and never counts locally', async () => {
    const dead = secondInstance({ redisUrl: 'redis://127.0.0.1:1' });
    const client = newClient();
    const responses: Response[] = [];
    // Sequential and parallel: a process-local fallback counter would start
    // rejecting with 429 (or admitting) after a few requests.
    for (let index = 0; index < 8; index += 1)
      responses.push(
        await dead.handlers.POST(
          jsonPost(
            '/api/auth/sign-in/magic-link',
            { email: testApp.freshEmail() },
            { [CLIENT_IP_HEADER]: client },
          ),
        ),
      );
    responses.push(
      ...(await Promise.all(
        Array.from({ length: 40 }, () =>
          dead.handlers.POST(
            jsonPost(
              '/api/auth/sign-in/magic-link',
              { email: testApp.freshEmail() },
              { [CLIENT_IP_HEADER]: client },
            ),
          ),
        ),
      )),
    );
    const sample = responses[0];
    const body = JSON.stringify(await sample?.clone().json());
    assert({
      given: 'an unreachable Redis and 48 requests from one client',
      should:
        'return 503 for all, with Retry-After and a fixed public body, and deliver nothing',
      actual: {
        tally: statuses(responses),
        retryAfter: sample?.headers.get('retry-after'),
        message: (JSON.parse(body) as { message: string }).message,
        leaks: ['127.0.0.1', 'redis', 'ECONNREFUSED', 'stack'].filter(
          (needle) => body.toLowerCase().includes(needle.toLowerCase()),
        ),
        delivered: dead.sent.length,
      },
      expected: {
        tally: { 503: 48 },
        retryAfter: '5',
        message: 'Service temporarily unavailable',
        leaks: [],
        delivered: 0,
      },
    });
  });

  test('a limiter failure inside the recipient gate also fails closed', async () => {
    const flaky = secondInstance({
      limiter: (base) => ({
        consume: (key, rule) =>
          key.startsWith('auth:magic-link:recipient:')
            ? Promise.reject(new Error('redis down'))
            : base.consume(key, rule),
      }),
    });
    const response = await flaky.handlers.POST(
      jsonPost('/api/auth/sign-in/magic-link', { email: testApp.freshEmail() }),
    );
    assert({
      given: 'the recipient counter becoming unavailable mid-request',
      should: 'answer 503 with a retryable code and send no mail',
      actual: {
        status: response.status,
        message: ((await response.json()) as { message?: string }).message,
        retryAfter: response.headers.get('retry-after'),
        delivered: flaky.sent.length,
      },
      expected: {
        status: 503,
        message: 'Service temporarily unavailable',
        retryAfter: '5',
        delivered: 0,
      },
    });
  });
});

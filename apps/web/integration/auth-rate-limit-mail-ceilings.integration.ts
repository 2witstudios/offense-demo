import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestApp, type TestApp } from './fixtures';
import { elapse, recipientBucket, statuses } from './auth-rate-limit-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

// Each ceiling gets its own app, so each starts from empty buckets: the
// global ceilings are application-wide, and the admitted requests of one
// test would otherwise count against another in whichever order they run.
const hourApp = createTestApp();
const dayApp = createTestApp();
const globalDayApp = createTestApp();
const globalApp = createTestApp();

/** A magic-link recipient bucket key, as `rate-limit.ts` builds it. */
const recipientKey = (testApp: TestApp, email: string, window: number) =>
  recipientBucket(testApp, 'magic-link', email, window);

const magicLink = (
  headers: Record<string, string> = {},
  email = globalApp.freshEmail(),
) =>
  globalApp.routes.auth.POST(
    globalApp.jsonPost('/api/auth/sign-in/magic-link', { email }, headers),
  );

describe('ISSUE-5 AC4 per-recipient and global mail-volume ceilings', () => {
  test('one recipient across many clients: the real hour ceiling denies the eleventh', async () => {
    const email = hourApp.freshEmail();
    const responses: Response[] = [];
    for (let index = 0; index < 11; index += 1) {
      // The minute window elapses between requests; the hour and day
      // buckets keep their real Redis counts.
      await elapse(hourApp, recipientKey(hourApp, email, 60));
      responses.push(
        await hourApp.routes.auth.POST(
          hourApp.jsonPost(
            '/api/auth/sign-in/magic-link',
            { email },
            { [CLIENT_IP_HEADER]: hourApp.newClient() },
          ),
        ),
      );
    }
    assert({
      given:
        'eleven requests for one recipient from distinct clients, a minute apart, against real Redis',
      should:
        'admit ten (the recipient hour ceiling) and deny the eleventh with an hour-long retry',
      actual: {
        tally: statuses(responses),
        retryAfter: Number(responses.at(-1)?.headers.get('retry-after')) > 60,
      },
      expected: { tally: { 200: 10, 429: 1 }, retryAfter: true },
    });
  });

  test('one recipient across many clients: the real day ceiling denies the twenty-first', async () => {
    const email = dayApp.freshEmail();
    const responses: Response[] = [];
    for (let index = 0; index < 21; index += 1) {
      // Both the minute and the hour windows elapse between requests; only
      // the day bucket keeps counting.
      await elapse(
        dayApp,
        recipientKey(dayApp, email, 60),
        recipientKey(dayApp, email, 3_600),
      );
      responses.push(
        await dayApp.routes.auth.POST(
          dayApp.jsonPost(
            '/api/auth/sign-in/magic-link',
            { email },
            { [CLIENT_IP_HEADER]: dayApp.newClient() },
          ),
        ),
      );
    }
    assert({
      given:
        'twenty-one requests for one recipient from distinct clients, an hour apart, against real Redis',
      should:
        'admit twenty (the recipient day ceiling) and deny the twenty-first with a retry past an hour',
      actual: {
        tally: statuses(responses),
        retryAfter:
          Number(responses.at(-1)?.headers.get('retry-after')) > 3_600,
      },
      expected: { tally: { 200: 20, 429: 1 }, retryAfter: true },
    });
  });

  test('the real global day ceiling mails no 3,001st distinct recipient of the day', async () => {
    const before = globalDayApp.mailbox.mails.length;
    const responses: Response[] = [];
    // 3,001 requests in bursts of 100, each its own client and recipient;
    // the global minute window elapses between bursts.
    for (let sent = 0; sent < 3_001; sent += 100) {
      await elapse(globalDayApp, 'auth:magic-link:global:60');
      responses.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(100, 3_001 - sent) }, () =>
            globalDayApp.routes.auth.POST(
              globalDayApp.jsonPost(
                '/api/auth/sign-in/magic-link',
                { email: globalDayApp.freshEmail() },
                { [CLIENT_IP_HEADER]: globalDayApp.newClient() },
              ),
            ),
          ),
        )),
      );
    }
    assert({
      given:
        '3,001 magic-link requests over a simulated day, each its own client and recipient, against real Redis',
      should:
        'mail exactly 3,000 (the global day ceiling) and answer the one past it with the same success, mailing nothing (ISSUE-182)',
      actual: {
        tally: statuses(responses),
        mails: globalDayApp.mailbox.mails.length - before,
      },
      expected: { tally: { 200: 3_001 }, mails: 3_000 },
    });
  }, 180_000);

  test('the global per-minute ceiling stops mail once 120 distinct recipients have sent this minute', async () => {
    const before = globalApp.mailbox.mails.length;
    const responses = await Promise.all(
      Array.from({ length: 121 }, () =>
        magicLink(
          { [CLIENT_IP_HEADER]: globalApp.newClient() },
          globalApp.freshEmail(),
        ),
      ),
    );
    assert({
      given:
        '121 simultaneous magic-link requests, each its own client and recipient',
      should:
        'mail exactly 120 (the global per-minute ceiling), independent of any single client or recipient bucket, and answer the one past it with the same success (ISSUE-182)',
      actual: {
        tally: statuses(responses),
        mails: globalApp.mailbox.mails.length - before,
      },
      expected: { tally: { 200: 121 }, mails: 120 },
    });
  });
});

import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { GLOBAL_MINUTE, saturateGlobalMinute } from './auth-ceiling-helpers';
import { elapse } from './auth-rate-limit-helpers';
import { createAccountFlows } from './auth-account-helpers';
import { createTestApp } from './fixtures';
import { serveEdge } from './ops-edge';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';

/**
 * ISSUE-220: a flood that fills the handed-off work's bound sheds sign-in
 * mail with everything else (DEC-73). That must reach an operator: the
 * composed app's logger tap counts every `auth.mail.shed`, and
 * `/api/ops/alerts` (what the AUTH-7.7 probe reads) fires `mail_shed` once
 * the count over its window reaches the documented threshold.
 */
requireTestServices(process.env);
setupRitewayBun();

const opsToken = `ops-${createId()}${createId()}`;
// One slot and no queue, so one held send fills the handed-off work's
// bound; production needs 577 (ADR 0025).
const testApp = createTestApp(
  { OPS_PROBE_TOKEN: opsToken },
  { maxRunning: 1, maxQueued: 0, dbSteps: 4 },
);
const accounts = createAccountFlows(testApp);
const { app, routes, mailbox, freshEmail, jsonPost, newClient } = testApp;

const magicLink = (email: string) =>
  routes.auth.POST(
    jsonPost(
      '/api/auth/sign-in/magic-link',
      { email },
      { [CLIENT_IP_HEADER]: newClient() },
    ),
  );

/** New addresses behind the held send: all shed, well past the threshold. */
const FLOOD = 40;

describe('ISSUE-220 shedding past the bound raises an operator alert', () => {
  test('a flood that sheds handed-off work fires mail_shed on /api/ops/alerts, with counts only', async () => {
    const edge = await serveEdge({ app, routes, opsToken });
    try {
      const before = await edge.alerts();
      await elapse(testApp, GLOBAL_MINUTE);
      const existing = (await accounts.signUp()).email;
      await saturateGlobalMinute({
        testApp,
        magicLink,
        fresh: freshEmail,
        settled: () => app.auth().settled(),
      });
      // A real sign-in whose send the provider holds fills the one slot.
      const release = mailbox.hold();
      await magicLink(existing);
      const { events } = await testApp.withLoggedEvents(() =>
        Promise.all(
          Array.from({ length: FLOOD }, () => magicLink(freshEmail())),
        ),
      );
      const shed = events.filter((event) => event === 'auth.mail.shed').length;
      const after = await edge.alerts();
      release();
      await app.auth().settled();
      assert({
        given: `the real minute ceiling saturated, the handed-off work's bound filled by a held send, then ${FLOOD} new addresses (${shed} shed)`,
        should:
          'fire mail_shed on /api/ops/alerts, where nothing fired for it before, with the shed count in the snapshot and no address in the condition',
        actual: {
          firedBefore: before.conditions?.includes('mail_shed'),
          firedAfter: after.conditions?.includes('mail_shed'),
          counted: after.snapshot?.mailShed?.count === shed,
          condition: JSON.stringify(after).includes('@')
            ? 'has an address'
            : 'counts only',
        },
        expected: {
          firedBefore: false,
          firedAfter: true,
          counted: true,
          condition: 'counts only',
        },
      });
    } finally {
      await edge.close();
    }
  }, 300_000);
});

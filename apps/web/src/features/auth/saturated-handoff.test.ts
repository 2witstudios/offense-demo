import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  AFTER_RESPONSE_MAX_QUEUED,
  AFTER_RESPONSE_MAX_RUNNING,
} from './after-response';
import {
  create,
  observableAnswer,
  existingAccount,
  magicLinkRequest,
} from './abuse.test-support';

setupRitewayBun();

describe('a saturated ceiling answers before any account-dependent work (ISSUE-185)', () => {
  const saturatedHeld = () =>
    create({
      heldTransport: true,
      limiter: () => async (key) =>
        key.startsWith('auth:magic-link:global:')
          ? { allowed: false, retryAfterSeconds: 30 }
          : { allowed: true, retryAfterSeconds: 0 },
    });

  /**
   * The request's answer, or the fact that it was still waiting once the
   * held transport had been reached and every queued task had run.
   */
  const answerOrWaiting = (
    harness: ReturnType<typeof saturatedHeld>,
  ): Promise<{ answered: number; trace: string[] } | 'waiting on delivery'> =>
    Promise.race([
      harness.server.instance.handler(magicLinkRequest()).then((response) => ({
        answered: response.status,
        trace: [...harness.trace],
      })),
      harness.transportReached
        .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
        .then(() => 'waiting on delivery' as const),
    ]);

  test('an existing account and an unknown address answer with the same work done, while the transport has not answered', async () => {
    const unknown = saturatedHeld();
    const known = saturatedHeld();
    known.db.user.push(existingAccount);
    const unknownAnswer = await answerOrWaiting(unknown);
    const knownAnswer = await answerOrWaiting(known);
    assert({
      given:
        'saturated global ceilings and a mail transport that has not answered, for an address with and without an account',
      should:
        'answer both 200 after the identical seam calls (the limiter buckets and the suppression check), with no send, lookup-dependent step or receipt before the answer',
      actual: knownAnswer,
      expected: unknownAnswer,
    });
    assert({
      given: 'the same two requests',
      should: 'answer 200 without waiting on delivery',
      actual:
        unknownAnswer === 'waiting on delivery'
          ? unknownAnswer
          : unknownAnswer.answered,
      expected: 200,
    });
  });

  test('once answered, the existing account is still mailed and the unknown address still dropped', async () => {
    const unknown = saturatedHeld();
    const known = saturatedHeld();
    known.db.user.push(existingAccount);
    await answerOrWaiting(unknown);
    await answerOrWaiting(known);
    known.release();
    unknown.release();
    await Promise.all([known.server.settled(), unknown.server.settled()]);
    assert({
      given: 'the saturated requests above, after the transport answers',
      should:
        'mail and keep the token of the existing account only, and delete the unknown address token',
      actual: {
        sent: [known.sent.length, unknown.sent.length],
        tokens: [known.db.verification.length, unknown.db.verification.length],
      },
      expected: { sent: [1, 0], tokens: [1, 0] },
    });
  });

  test('past the bound, an existing account and an unknown address are shed alike, before any lookup (DEC-73)', async () => {
    const harness = saturatedHeld();
    harness.db.user.push(existingAccount);
    const bound = AFTER_RESPONSE_MAX_RUNNING + AFTER_RESPONSE_MAX_QUEUED;
    for (let index = 0; index < bound; index += 1)
      await harness.server.instance.handler(magicLinkRequest());
    const tokensBefore = harness.db.verification.length;
    const knownAnswer = await observableAnswer(
      await harness.server.instance.handler(magicLinkRequest()),
    );
    const unknownAnswer = await observableAnswer(
      await harness.server.instance.handler(
        magicLinkRequest({}, 'newcomer@offense-demo.example.com'),
      ),
    );
    harness.release();
    await harness.server.settled();
    assert({
      given: `saturated ceilings and ${bound} handed-off sign-ins the transport has not answered, then one more request for an existing account and one for an unknown address`,
      should:
        'answer both alike, shed both with a log line, mail neither, and leave both tokens untouched (no lookup, send or drop ran)',
      actual: {
        known: knownAnswer,
        status: knownAnswer.status,
        shed: harness.logs.filter(([event]) => event === 'auth.mail.shed')
          .length,
        sent: harness.sent.length,
        tokensKept: harness.db.verification.length - tokensBefore,
      },
      expected: {
        known: unknownAnswer,
        status: 200,
        shed: 2,
        sent: bound,
        tokensKept: 2,
      },
    });
  });
});

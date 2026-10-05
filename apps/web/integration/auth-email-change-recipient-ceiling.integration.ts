import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { createPasskeyFlows } from './auth-passkey-flows';
import { elapse, recipientBucket } from './auth-rate-limit-helpers';
import { linkFrom, tokenOf } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-121: since ISSUE-119 an approved change to a taken address mails
 * that address's owner a notice, and a free one gets a verification link.
 * The new address is metered at /change-email by the same recipient windows
 * as a sign-in link (3 a minute, 10 an hour, 20 a day, ADR 0025) under an
 * email-change key, so rotating clients cannot flood one inbox. The bucket
 * is keyed on the address alone, so a free and a taken address are refused
 * alike.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { testApp, mailbox } = flows.account.flows;
const DAY_CEILING = 20;
const ADMITTED = '200 {"status":true} retry>1h=false';

/** The minute and hour windows of `address` elapsing; the day keeps counting. */
const elapseMinuteAndHour = (address: string) =>
  elapse(
    testApp,
    recipientBucket(testApp, 'email-change', address, 60),
    recipientBucket(testApp, 'email-change', address, 3_600),
  );

/**
 * One more change than the day ceiling to `address`, each from a new client
 * (`flows.changeEmail` rotates them) and approved from the old inbox when
 * admitted: every answer, and how many mails reached `address`.
 */
const floodChanges = async (cookie: string, address: string) => {
  const answers: string[] = [];
  const before = mailbox.mails.length;
  for (let round = 0; round <= DAY_CEILING; round += 1) {
    await elapseMinuteAndHour(address);
    const sentBefore = mailbox.mails.length;
    const response = await flows.changeEmail(cookie, address);
    const retryAfter = Number(response.headers.get('retry-after'));
    answers.push(
      `${response.status} ${await response.text()} retry>1h=${retryAfter > 3_600}`,
    );
    const approval = mailbox.mails[sentBefore];
    if (response.ok && approval)
      await flows.confirmEmailPost(tokenOf(linkFrom(approval)));
  }
  const admitted = answers.filter((answer) => answer === ADMITTED);
  return {
    admitted: admitted.length,
    refusals: answers.filter((answer) => answer !== ADMITTED),
    mailed: mailbox.mails.slice(before).filter((mail) => mail.to === address)
      .length,
  };
};

describe('ISSUE-121 email-change mail to a new address is metered per recipient', () => {
  test('rotating clients cannot mail a taken or a free address past the day ceiling, and both are refused alike', async () => {
    const requester = await flows.account.signUp();
    const { email: taken } = await flows.account.signUp();
    const free = `${createId()}@example.test`;
    const toTaken = await floodChanges(requester.cookie, taken);
    const toFree = await floodChanges(requester.cookie, free);
    assert({
      given:
        'one signed-in account asking the real route 21 times, from a new client each time and with the minute and hour windows elapsed, to move to another account’s address and then to a free one',
      should:
        'admit twenty for each, refuse the twenty-first with a 429 and a retry past an hour, and mail each address no more than twenty times',
      actual: {
        taken: { admitted: toTaken.admitted, mailed: toTaken.mailed },
        free: { admitted: toFree.admitted, mailed: toFree.mailed },
        refusals: toTaken.refusals.map((answer) =>
          answer.replace(/ .* /, ' … '),
        ),
      },
      expected: {
        taken: { admitted: DAY_CEILING, mailed: DAY_CEILING },
        free: { admitted: DAY_CEILING, mailed: DAY_CEILING },
        refusals: ['429 … retry>1h=true'],
      },
    });
    assert({
      given: 'the refusals for the taken and the free address',
      should:
        'be byte for byte the same, so the ceiling reveals nothing about which address has an account',
      actual: toTaken.refusals,
      expected: toFree.refusals,
    });
  }, 60_000);
});

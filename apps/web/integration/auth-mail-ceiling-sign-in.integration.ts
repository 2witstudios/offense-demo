import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createCeilingFlows } from './auth-ceiling-helpers';
import { statuses } from './auth-rate-limit-helpers';
import { counts } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-54 AC2: the whole-application magic-link ceilings (120/minute,
 * 3,000/day) protect Resend quota and domain reputation. Every send counts
 * against them, but only sign-ups (links to addresses with no account) are
 * held back, so one client rotating IPv6 /128 addresses and plus-addressed
 * recipients can drain them to delay new sign-ups but never deny sign-in.
 *
 * ISSUE-182 and ISSUE-188: a saturated ceiling answers an unknown address
 * exactly as an existing account's, sends it no mail, and is spent alike by
 * both, so neither the answer nor a caller's own follow-up request reveals
 * which address has an account. Only operators see the saturation, in the
 * structured log.
 */
requireTestServices(process.env);
setupRitewayBun();

const {
  accounts,
  testApp,
  mailbox,
  newClient,
  fresh,
  magicLink,
  elapseGlobalMinute,
  settled,
} = createCeilingFlows();

/** Fills the global minute ceiling with 120 new addresses, each its own client. */
const saturate = async () => {
  await elapseGlobalMinute();
  await Promise.all(Array.from({ length: 120 }, () => magicLink(fresh())));
};

/** Headers whose value is unique to every response: compared by presence. */
const PER_RESPONSE = new Set(['date', 'x-request-id']);

/**
 * Everything a caller can observe of an answer: status, body and every
 * header, with per-response values reduced to their presence.
 */
const observable = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
  headers: [...response.headers.entries()]
    .map(([name, value]) => [name, PER_RESPONSE.has(name) ? '*' : value])
    .sort(([left = ''], [right = '']) => left.localeCompare(right)),
});

/** Mails sent to `email` by `work`, including after its answer. */
const mailsTo = async (email: string, work: () => Promise<Response>) => {
  const before = mailbox.mails.length;
  const response = await work();
  await settled();
  return {
    response,
    mails: mailbox.mails.slice(before).filter((mail) => mail.to === email)
      .length,
  };
};

describe('ISSUE-54 the global mail ceiling cannot deny sign-in', () => {
  test('with the global minute ceiling drained by new-address requests, existing accounts still get their sign-in links', async () => {
    const existing = [
      (await accounts.signUp()).email,
      (await accounts.signUp()).email,
      (await accounts.signUp()).email,
    ];
    await elapseGlobalMinute();

    // One attacker draining the ceiling: every request its own client address
    // (IPv6 /128 rotation) and its own new recipient (plus-addressing).
    const beforeDrain = mailbox.mails.length;
    const drain = await Promise.all(
      Array.from({ length: 125 }, () => magicLink(fresh())),
    );
    const before = mailbox.mails.length;
    const drainMails = before - beforeDrain;
    const [signIns, laterSignUps] = await Promise.all([
      Promise.all(existing.map((email) => magicLink(email))),
      Promise.all(Array.from({ length: 10 }, () => magicLink(fresh()))),
    ]);
    await settled();
    const mailed = mailbox.mails.slice(before).map((mail) => mail.to);
    const mailedAccounts = mailed.filter((to) => existing.includes(to)).length;

    assert({
      given:
        '125 simultaneous new-address requests from distinct clients against real Redis, then sign-in requests for three existing accounts racing ten more new addresses',
      should:
        'mail exactly 120 new addresses, and admit and mail every existing account while the later new addresses get the same success and no mail',
      actual: {
        drain: statuses(drain),
        drainMails,
        signIns: statuses(signIns),
        mailedAccounts,
        laterSignUps: statuses(laterSignUps),
        laterSignUpMails: mailed.length - mailedAccounts,
      },
      expected: {
        drain: { 200: 125 },
        drainMails: 120,
        signIns: { 200: 3 },
        mailedAccounts: 3,
        laterSignUps: { 200: 10 },
        laterSignUpMails: 0,
      },
    });
  });
});

describe('ISSUE-182 a saturated sign-up ceiling reveals no account', () => {
  test('an unknown address and an existing account get the same answer while the ceiling is saturated', async () => {
    await elapseGlobalMinute();
    const existing = (await accounts.signUp()).email;
    await saturate();
    const unknown = fresh();

    const { result: unknownProbe, events } = await testApp.withLoggedEvents(
      () => mailsTo(unknown, () => magicLink(unknown)),
    );
    const existingProbe = await mailsTo(existing, () => magicLink(existing));
    const unknownAnswer = await observable(unknownProbe.response);
    const existingAnswer = await observable(existingProbe.response);

    assert({
      given:
        'the real global minute ceiling saturated by 120 new addresses, then a request for a new address and one for an existing account',
      should:
        'answer both with the same status, body and headers (no Retry-After), mail only the existing account and keep no token for the unknown one, and log the saturation for operators',
      actual: {
        sameAnswer: unknownAnswer,
        status: unknownAnswer.status,
        retryAfter: unknownProbe.response.headers.has('retry-after'),
        unknownMails: unknownProbe.mails,
        unknownTokens: (await counts({ email: unknown })).verifications,
        existingMails: existingProbe.mails,
        saturationLogged: events.includes('auth.rate_limit.denied'),
      },
      expected: {
        sameAnswer: existingAnswer,
        status: 200,
        retryAfter: false,
        unknownMails: 0,
        unknownTokens: 0,
        existingMails: 1,
        saturationLogged: true,
      },
    });
  });

  test('while the ceiling is saturated, the per-client and per-recipient limits still meter unknown addresses', async () => {
    await saturate();
    const client = newClient();
    const fromOneClient = [];
    for (let index = 0; index < 4; index += 1)
      fromOneClient.push(await magicLink(fresh(), client));
    const unknown = fresh();
    const toOneAddress = [];
    for (let index = 0; index < 4; index += 1)
      toOneAddress.push(await magicLink(unknown));

    assert({
      given:
        'a saturated ceiling, then four new addresses from one client and four requests for one new address from distinct clients',
      should:
        'deny the fourth of each on its client and recipient minute windows',
      actual: {
        fromOneClient: fromOneClient.map((response) => response.status),
        toOneAddress: toOneAddress.map((response) => response.status),
      },
      expected: {
        fromOneClient: [200, 200, 200, 429],
        toOneAddress: [200, 200, 200, 429],
      },
    });
  });

  test('below the ceiling, an unknown address and an existing account are both admitted and mailed', async () => {
    await elapseGlobalMinute();
    const existing = (await accounts.signUp()).email;
    const unknown = fresh();
    const unknownProbe = await mailsTo(unknown, () => magicLink(unknown));
    const existingProbe = await mailsTo(existing, () => magicLink(existing));

    assert({
      given:
        'a global ceiling with room, then a new address and an existing account',
      should: 'admit and mail both',
      actual: statuses([unknownProbe.response, existingProbe.response]),
      expected: { 200: 2 },
    });
    assert({
      given: 'the same two requests',
      should: 'send one mail to each',
      actual: [unknownProbe.mails, existingProbe.mails],
      expected: [1, 1],
    });
  });
});

describe('ISSUE-188 the sign-up ceiling counter reveals no account', () => {
  /**
   * The reviewer's canary attack: fill the minute ceiling to 119 with the
   * caller's own new addresses, request the target, then one more own
   * address. Whether that canary is mailed must not depend on the target.
   */
  const canaryAfter = async (target: string) => {
    await elapseGlobalMinute();
    await Promise.all(Array.from({ length: 119 }, () => magicLink(fresh())));
    const targetResponse = await magicLink(target);
    const canary = fresh();
    const { response, mails } = await mailsTo(canary, () => magicLink(canary));
    return {
      targetStatus: targetResponse.status,
      canaryStatus: response.status,
      canaryMailed: mails,
    };
  };

  test('a canary sent after the target is mailed the same whether or not the target has an account', async () => {
    await elapseGlobalMinute();
    const existing = (await accounts.signUp()).email;
    const existingProbe = await canaryAfter(existing);
    const unknownProbe = await canaryAfter(fresh());
    assert({
      given:
        'the real minute ceiling filled to 119 by own addresses, a request for the target, then one more own address, once for an existing account and once for an unknown address',
      should:
        'answer and mail (or not mail) the canary identically in both probes, the target having spent the last slot either way',
      actual: existingProbe,
      expected: unknownProbe,
    });
    assert({
      given: 'the same probe',
      should: 'leave no room for the canary after either target',
      actual: [existingProbe.canaryMailed, unknownProbe.canaryMailed],
      expected: [0, 0],
    });
  });
});

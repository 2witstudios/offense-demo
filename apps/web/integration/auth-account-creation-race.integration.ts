import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createFlows } from './auth-mounted-flows';
import { counts, tokenOf } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const { requestLink, redeem, fresh } = createFlows();

describe('AUTH-6.3 concurrent account creation', () => {
  test('two brand-new tokens for the same never-before-seen email create exactly one user account', async () => {
    // Distinct from a replay race (one token redeemed many times): these are
    // two genuinely separate, valid tokens from two separate requests for a
    // new address, racing to create the account for the first time. The
    // guarantee under test is user-creation dedup, not single-use
    // token consumption.
    const email = fresh();
    const first = await requestLink(email);
    const second = await requestLink(email);
    const results = await Promise.all([
      redeem(tokenOf(first.link as URL)),
      redeem(tokenOf(second.link as URL)),
    ]);
    const cookies = (result: Response) => result.headers.getSetCookie().length;
    const winners = results.filter((result) => cookies(result) > 0);
    const losers = results.filter((result) => cookies(result) === 0);
    const loserBody = losers.length > 0 ? await losers[0]?.text() : '';
    // The database's unique email constraint dedups the user row; the
    // underlying create-or-find-existing race is resolved inside the
    // vendored magic-link plugin, and either safe outcome is acceptable:
    // both redemptions can win their own session against the one
    // deduplicated user (verified against a real, unloaded Postgres/Redis
    // pair — see PR #47 review), or one can lose and must then fail safely
    // (a retryable 503 with no SQL/detail leak, never a crash or a second
    // user row). What must never happen is a duplicate account or a leak.
    assert({
      given:
        'two distinct valid tokens for the same new email redeemed concurrently',
      should:
        'create exactly one user account, and let every non-winning response fail safely with no detail leak',
      actual: {
        atLeastOneWinner: winners.length >= 1,
        loserStatusIsSafeOrAbsent:
          losers.length === 0 || losers[0]?.status === 503,
        loserLeaksDetail: /insert into|params:|\$1/i.test(loserBody ?? ''),
        counts: await counts(email),
      },
      expected: {
        atLeastOneWinner: true,
        loserStatusIsSafeOrAbsent: true,
        loserLeaksDetail: false,
        counts: {
          users: 1,
          sessions: winners.length,
          verifications: 0,
          passkeys: 0,
        },
      },
    });
  });
});

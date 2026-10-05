import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { PROJECT_CREATE_RULE } from '../src/features/projects/projects';
import { createProjectFlows, read, rowsOf } from './projects-flows';

requireTestServices(process.env);
setupRitewayBun();
const { memberAccount, create } = createProjectFlows();

describe('PROJ-2.4 POST /api/projects gate strictness and order', () => {
  test('a member POST with no Origin and no Sec-Fetch-Site is refused with AUTHORIZATION', async () => {
    const { cookie, userId } = await memberAccount();
    const answers = await Promise.all(
      // A valid body (were the gate open it would be created) and an invalid
      // one (were the session resolved and the body read it would be 400).
      [{ name: 'Mine' }, { name: 'Mine', extra: true }].map(async (body) => {
        const { status, body: answer } = await read(
          await create(cookie, body, {}, ['origin', 'sec-fetch-site']),
        );
        return [status, answer.error?.code];
      }),
    );
    assert({
      given:
        'a member’s cookie on POSTs that carry neither an Origin nor a Sec-Fetch-Site header',
      should:
        'answer 403 AUTHORIZATION (not 201, not VALIDATION) and store nothing',
      actual: { answers, rows: await rowsOf(userId) },
      expected: {
        answers: Array(2).fill([403, 'AUTHORIZATION']),
        rows: [],
      },
    });
  });

  test('a member’s invalid bodies spend the create ceiling before the body is read', async () => {
    const { cookie, userId } = await memberAccount();
    // Real concurrent requests against the real Redis limiter, every body invalid.
    const invalid = await Promise.all(
      Array.from({ length: PROJECT_CREATE_RULE.max }, async (_, index) => {
        const { status, body } = await read(
          await create(cookie, { name: `Spent ${index}`, extra: true }),
        );
        return [status, body.error?.code];
      }),
    );
    const valid = await read(await create(cookie, { name: 'After the burst' }));
    assert({
      given: `${PROJECT_CREATE_RULE.max} invalid POSTs by one member, then a valid one`,
      should:
        'refuse each invalid body as VALIDATION yet count it against the ceiling, so the valid POST is refused with RATE_LIMIT and nothing is stored',
      actual: {
        invalid,
        valid: [valid.status, valid.body.error?.code],
        rows: await rowsOf(userId),
      },
      expected: {
        invalid: Array(PROJECT_CREATE_RULE.max).fill([400, 'VALIDATION']),
        valid: [429, 'RATE_LIMIT'],
        rows: [],
      },
    });
  });
});

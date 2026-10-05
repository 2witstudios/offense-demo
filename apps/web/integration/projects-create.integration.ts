import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { isCuid } from '@paralleldrive/cuid2';
import { requireTestServices } from '@offense-demo/config';
import { projectInvariantIds } from '@offense-demo/domain';
import { uniqueName } from './auth-account-helpers';
import { PROJECT_CREATE_RULE } from '../src/features/projects/projects';
import {
  createProjectFlows,
  projectsNamed,
  read,
  rowsOf,
} from './projects-flows';

requireTestServices(process.env);
setupRitewayBun();
const { memberAccount, provisionalAccount, create } = createProjectFlows();

describe('PROJ-2.1 POST /api/projects', () => {
  test('a member creates a project owned by their session principal', async () => {
    const { cookie, userId } = await memberAccount();
    const { status, body } = await read(
      await create(cookie, { name: '  Launch plan  ' }),
    );
    const rows = await rowsOf(userId);
    const project = body.project!;
    assert({
      given: 'a member posting { name } through the real route',
      should:
        'answer 201 with the domain-created project and store exactly that project under the principal',
      actual: {
        status,
        name: project.name,
        projectStatus: project.status,
        cuid: isCuid(project.id),
        sameTimestamps: project.createdAt === project.updatedAt,
        stored: rows.map((row) => ({
          id: row.id,
          owner: row.owner_user_id,
          name: row.name,
          status: row.status,
          version: row.version,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
      },
      expected: {
        status: 201,
        name: 'Launch plan',
        projectStatus: 'active',
        cuid: true,
        sameTimestamps: true,
        stored: [
          {
            id: project.id,
            owner: userId,
            name: 'Launch plan',
            status: 'active',
            version: 1,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        ],
      },
    });
  });

  test('a provisional account is refused with AUTHORIZATION and nothing is written', async () => {
    const { cookie, userId } = await provisionalAccount();
    const { status, body } = await read(
      await create(cookie, { name: 'Launch plan' }),
    );
    assert({
      given: 'a signed-in account with no username posting a valid body',
      should: 'answer 403 AUTHORIZATION and store no project',
      actual: { status, code: body.error?.code, rows: await rowsOf(userId) },
      expected: { status: 403, code: 'AUTHORIZATION', rows: [] },
    });
  });

  test('an anonymous POST with an invalid body is refused with AUTHENTICATION', async () => {
    const marker = `anonymous ${uniqueName()}`;
    const answers = await Promise.all(
      [
        {},
        { name: 42 },
        { name: marker, ownerUserId: 'someone' },
        { name: marker, extra: true },
        'not json',
      ].map(async (body) => {
        const { status, body: answer } = await read(await create(null, body));
        return [status, answer.error?.code];
      }),
    );
    assert({
      given: 'anonymous POSTs whose bodies would each fail validation',
      should:
        'answer 401 AUTHENTICATION, not VALIDATION (authorization runs before the body is read), and write nothing',
      actual: { answers, written: await projectsNamed(marker) },
      expected: {
        answers: Array(5).fill([401, 'AUTHENTICATION']),
        written: 0,
      },
    });
  });

  test('a body with any field besides name, an owner id included, is VALIDATION and writes nothing', async () => {
    const { cookie, userId } = await memberAccount();
    const victim = await memberAccount();
    const answers = await Promise.all(
      [
        { name: 'Mine', ownerUserId: victim.userId },
        { name: 'Mine', owner_user_id: victim.userId },
        { name: 'Mine', id: 'chosen-id' },
        { name: 'Mine', status: 'archived' },
        { name: 42 },
        {},
        ['Mine'],
      ].map(async (body) => {
        const { status, body: answer } = await read(await create(cookie, body));
        return [status, answer.error?.code];
      }),
    );
    assert({
      given:
        'member bodies carrying extra fields, a victim’s owner id among them',
      should: 'answer 400 VALIDATION and store nothing for either account',
      actual: {
        answers,
        mine: await rowsOf(userId),
        theirs: await rowsOf(victim.userId),
      },
      expected: {
        answers: Array(7).fill([400, 'VALIDATION']),
        mine: [],
        theirs: [],
      },
    });
  });

  test('a blank name or one over 120 characters is refused with the domain invariant', async () => {
    const { cookie, userId } = await memberAccount();
    const answers = await Promise.all(
      ['', '    ', 'a'.repeat(121)].map(async (name) => {
        const { status, body } = await read(await create(cookie, { name }));
        return [status, body.error?.code, body.error?.invariantId];
      }),
    );
    assert({
      given: 'a member posting a blank name and a 121-character name',
      should: `answer 422 INVARIANT ${projectInvariantIds.nameValid} and store nothing`,
      actual: { answers, rows: await rowsOf(userId) },
      expected: {
        answers: Array(3).fill([
          422,
          'INVARIANT',
          projectInvariantIds.nameValid,
        ]),
        rows: [],
      },
    });
  });

  test('a cross-site POST is refused by the same-origin check before the body is read', async () => {
    const { cookie, userId } = await memberAccount();
    const answers = await Promise.all(
      [
        { origin: 'https://evil.example' },
        { origin: 'null', 'sec-fetch-site': 'same-origin' },
      ].map(async (headers) => {
        // An invalid body: were it read first, the answer would be 400.
        const { status, body } = await read(
          await create(cookie, { name: 'Mine', extra: true }, headers),
        );
        return [status, body.error?.code];
      }),
    );
    const valid = await read(
      await create(
        cookie,
        { name: 'Mine' },
        { origin: 'https://evil.example' },
      ),
    );
    assert({
      given:
        'a member’s cookie sent from another origin and from an opaque one',
      should:
        'answer 403 AUTHORIZATION (not VALIDATION) and store nothing, valid body or not',
      actual: {
        answers: [...answers, [valid.status, valid.body.error?.code]],
        rows: await rowsOf(userId),
      },
      expected: {
        answers: Array(3).fill([403, 'AUTHORIZATION']),
        rows: [],
      },
    });
  });
});

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

describe('ISSUE-3 project creation ceiling', () => {
  test('a member over the per-user create ceiling is refused with RATE_LIMIT and nothing more is written', async () => {
    const { cookie, userId } = await memberAccount();
    const other = await memberAccount();
    const attempts = PROJECT_CREATE_RULE.max + 5;
    // Real concurrent requests against the real Redis limiter.
    const answers = await Promise.all(
      Array.from({ length: attempts }, async (_, index) =>
        read(await create(cookie, { name: `Burst ${index}` })),
      ),
    );
    const statuses = answers.map(({ status }) => status).sort();
    const refusedCodes = [
      ...new Set(
        answers
          .filter(({ status }) => status === 429)
          .map(({ body }) => body.error?.code),
      ),
    ];
    const otherAnswer = await create(other.cookie, { name: 'Unaffected' });
    assert({
      given: `${attempts} concurrent creates by one member against a ceiling of ${PROJECT_CREATE_RULE.max}`,
      should:
        'create exactly the ceiling, refuse the rest with RATE_LIMIT, store only the created ones and leave another member unaffected',
      actual: {
        statuses,
        refusedCodes,
        stored: (await rowsOf(userId)).length,
        other: otherAnswer.status,
      },
      expected: {
        statuses: [
          ...Array(PROJECT_CREATE_RULE.max).fill(201),
          ...Array(5).fill(429),
        ],
        refusedCodes: ['RATE_LIMIT'],
        stored: PROJECT_CREATE_RULE.max,
        other: 201,
      },
    });
  });
});

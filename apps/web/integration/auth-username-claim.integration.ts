import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createAccountFlows,
  uniqueName,
  usernameOf,
} from './auth-account-helpers';
import { origin, withSql } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const { flows, signUp, claim } = createAccountFlows();
const { authRoute, newClient } = flows;

describe('AUTH-4.2 username claim', () => {
  test('concurrent claims of one name: exactly one 201, all others 409, losers unchanged', async () => {
    // Sign-ups are sequential (the shared mailbox matches mail by arrival
    // order); only the claims race.
    const contenders: Awaited<ReturnType<typeof signUp>>[] = [];
    for (let index = 0; index < 8; index += 1) contenders.push(await signUp());
    const name = uniqueName();
    const responses = await Promise.all(
      contenders.map(({ cookie }) => claim(cookie, { username: name })),
    );
    const statuses = responses.map((response) => response.status).sort();
    const owners = await withSql(
      (sql) => sql`SELECT email FROM users WHERE lower(username) = ${name}`,
    );
    const winnerEmail = owners[0]?.email as string;
    const losers = contenders.filter(({ email }) => email !== winnerEmail);
    const loserNames = await Promise.all(
      losers.map(({ email }) => usernameOf(email)),
    );
    const loserBodies = await Promise.all(
      responses
        .filter((response) => response.status === 409)
        .map(async (response) => (await response.json()).error.code),
    );
    assert({
      given: 'eight verified accounts claiming the same name at once',
      should:
        'grant exactly one 201, return a stable 409 to the rest and leave every loser without a username',
      actual: {
        statuses,
        owners: owners.length,
        loserNames,
        loserCodes: [...new Set(loserBodies)],
      },
      expected: {
        statuses: [201, 409, 409, 409, 409, 409, 409, 409],
        owners: 1,
        loserNames: Array(7).fill(null),
        loserCodes: ['USERNAME_TAKEN'],
      },
    });
  });

  test('names collide regardless of case, and the loser can still choose another', async () => {
    const first = await signUp();
    const second = await signUp();
    const name = uniqueName();
    const won = await claim(first.cookie, { username: name });
    const lost = await claim(second.cookie, { username: name.toUpperCase() });
    const retry = await claim(second.cookie, { username: uniqueName() });
    assert({
      given: 'a second account claiming the same name in capitals',
      should: 'answer 409 and then accept a different name',
      actual: [won.status, lost.status, retry.status],
      expected: [201, 409, 201],
    });
  });

  test('the owner retrying the same name succeeds idempotently; a different name is refused', async () => {
    const { email, cookie } = await signUp();
    const name = uniqueName();
    const first = await claim(cookie, { username: name });
    const again = await claim(cookie, { username: ` ${name.toUpperCase()} ` });
    const other = await claim(cookie, { username: uniqueName() });
    assert({
      given: 'a completed account',
      should:
        'answer 201, then 200 for the same name, then a 409 that changes nothing',
      actual: {
        statuses: [first.status, again.status, other.status],
        code: (await other.json()).error.code,
        stored: await usernameOf(email),
      },
      expected: {
        statuses: [201, 200, 409],
        code: 'USERNAME_ALREADY_SET',
        stored: name,
      },
    });
  });

  test('invalid names, extra fields and forged user ids are refused and change nothing', async () => {
    const { email, cookie } = await signUp();
    const victim = await signUp();
    const forgedVictim = await claim(cookie, {
      username: uniqueName(),
      id: (
        await withSql(
          (sql) => sql`SELECT id FROM users WHERE email = ${victim.email}`,
        )
      )[0]?.id,
    });
    const statuses = await Promise.all(
      [
        { username: 'ab' },
        { username: 'a'.repeat(33) },
        { username: 'has space' },
        { username: 'ünïcode' },
        { username: 42 },
        {},
        { username: uniqueName(), userId: 'someone-else' },
        { username: uniqueName(), role: 'moderator' },
        [uniqueName()],
      ].map(async (body) => (await claim(cookie, body)).status),
    );
    assert({
      given: 'malformed bodies and identity fields supplied by the caller',
      should: 'answer 400 and leave both accounts without usernames',
      actual: {
        statuses,
        forgedVictim: forgedVictim.status,
        mine: await usernameOf(email),
        theirs: await usernameOf(victim.email),
      },
      expected: {
        statuses: Array(9).fill(400),
        forgedVictim: 400,
        mine: null,
        theirs: null,
      },
    });
  });

  test('anonymous, cross-origin and cookie-forged callers are refused', async () => {
    const { email, cookie } = await signUp();
    const anonymous = await claim(null, { username: uniqueName() });
    const forged = await claim('better-auth.session_token=forged.value', {
      username: uniqueName(),
    });
    const crossOrigin = await claim(
      cookie,
      { username: uniqueName() },
      { origin: 'https://evil.example' },
    );
    assert({
      given: 'no session, a forged session and a foreign origin',
      should: 'answer 401, 401 and 403 without touching the account',
      actual: {
        statuses: [anonymous.status, forged.status, crossOrigin.status],
        stored: await usernameOf(email),
      },
      expected: { statuses: [401, 401, 403], stored: null },
    });
  });

  // /change-email is a real AUTH-5.6 surface (covered in its own suite), not
  // a disabled path: only the general profile-update bypass stays closed.
  test('the general profile update surface is closed', async () => {
    const { email, cookie } = await signUp();
    const update = await authRoute.POST(
      new Request(`${origin}/api/auth/update-user`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          cookie,
          [CLIENT_IP_HEADER]: newClient(),
        },
        body: JSON.stringify({ username: uniqueName(), name: 'Mallory' }),
      }),
    );
    assert({
      given: 'a signed-in account calling the general profile update endpoint',
      should: 'answer 404 and leave username and name untouched',
      actual: { status: update.status, stored: await usernameOf(email) },
      expected: { status: 404, stored: null },
    });
  });

  test('a claim burst is rate limited per account', async () => {
    const { cookie } = await signUp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      statuses.push((await claim(cookie, { username: 'no' })).status);
    assert({
      given: 'twelve rapid claims by one account',
      should: 'answer 400 ten times and then 429',
      actual: [
        statuses.slice(0, 10).every((status) => status === 400),
        statuses.slice(10),
      ],
      expected: [true, [429, 429]],
    });
  });
});

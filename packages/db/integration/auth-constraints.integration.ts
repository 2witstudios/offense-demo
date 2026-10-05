import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { rejected } from './constraint-helpers';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

test('usernames are unique regardless of case', async () => {
  const sql = new SQL(url);
  const ids = [createId(), createId(), createId()];
  const name = `Ada${createId()}`;
  const insert = (id: string, username: string) =>
    sql.unsafe('insert into users (id, username) values ($1, $2)', [
      id,
      username,
    ]);
  try {
    await insert(ids[0]!, name);
    const caseVariantRejected = await rejected(() =>
      insert(ids[1]!, name.toUpperCase()),
    );
    const distinctRejected = await rejected(() =>
      insert(ids[2]!, `${name}-other`),
    );
    assert({
      given: 'an existing username and a second differing only by case',
      should: 'reject the case variant and accept a genuinely distinct name',
      actual: { caseVariantRejected, distinctRejected },
      expected: { caseVariantRejected: true, distinctRejected: false },
    });
  } finally {
    await sql.unsafe('delete from users where id in ($1, $2, $3)', ids);
    await sql.close();
  }
});

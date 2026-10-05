import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { appendOutboxEvent } from '../src/outbox';
import { createTestOnlyOperations } from '../src/test-only-operations';
import { withFixture } from './constraint-helpers';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/**
 * ISSUE-4: drizzle-orm 0.45.2's built-in `jsonb()` double-encoded every
 * write (`JSON.stringify` in `mapToDriverValue`, then Bun SQL serializes
 * the resulting string again), so `jsonb_typeof` reported `'string'` and
 * `->>` read NULL. These assertions read the stored bytes directly with a
 * raw fixture connection, bypassing Drizzle's read path, which
 * `JSON.parse`s a double-encoded string back into an object and would hide
 * the bug.
 */
test('appendOutboxEvent stores payload as a real jsonb object, not a double-encoded string', async () => {
  const fixture = new SQL(url);
  const testOnly = createTestOnlyOperations({ client: fixture });
  const roomId = createId();
  const topic = `room:${roomId}`;
  try {
    await testOnly.transaction((tx) =>
      appendOutboxEvent(tx, {
        topic,
        kind: 'room.changed',
        version: 1,
        payload: {
          entityVersion: 1,
          kind: 'room.changed',
          ids: [roomId],
        },
      }),
    );
    const [row] = await fixture`
      select jsonb_typeof(payload) as type, payload->>'kind' as kind
      from outbox where topic = ${topic}
    `;
    assert({
      given: 'appendOutboxEvent',
      should: 'store payload as a jsonb object, not a double-encoded string',
      actual: { type: row?.type, kind: row?.kind },
      expected: { type: 'object', kind: 'room.changed' },
    });
  } finally {
    await fixture`delete from outbox where topic = ${topic}`;
    await fixture.close();
  }
});

test('every jsonb column refuses a scalar written around the application (ISSUE-24)', async () => {
  await withFixture(url, async (fixture) => {
    const scalar = 'a bare string';
    const topic = `room:${createId()}`;
    try {
      const refusals = {
        payload: await fixture.rejectedBy(
          'outbox',
          { topic, kind: 'k', version: 1, payload: scalar },
          'topic',
        ),
      };
      assert({
        given: 'a jsonb string bound to each jsonb column in raw SQL',
        should: "be refused by that column's _is_object CHECK",
        actual: refusals,
        expected: { payload: 'outbox_payload_is_object' },
      });
    } finally {
      await fixture.sql`delete from outbox where topic = ${topic}`;
    }
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { agentSeedUsers, agentSeedVersion } from './agent-seed';

setupRitewayBun();

const CUID2 = /^[a-z][a-z0-9]{23}$/;

describe('agentSeedUsers', () => {
  test('gives every seeded user a distinct cuid2 user id, actor id and username', () => {
    const ids = agentSeedUsers.flatMap((user) => [user.userId, user.actorId]);
    assert({
      given: 'the seeded development users',
      should: 'use distinct cuid2-shaped ids and distinct usernames',
      actual: {
        cuid2: ids.every((id) => CUID2.test(id)),
        distinctIds: new Set(ids).size === ids.length,
        distinctNames:
          new Set(agentSeedUsers.map((user) => user.username)).size ===
          agentSeedUsers.length,
      },
      expected: { cuid2: true, distinctIds: true, distinctNames: true },
    });
  });

  test('records the seed content under a version marker', () => {
    assert({
      given: 'the agent seed',
      should: 'carry the current durable seed version marker',
      actual: agentSeedVersion,
      expected: 'agent-seed-v1',
    });
  });
});

/**
 * `bun db:seed`: the local development fixture (the agent users and their
 * actors), written only through `@offense-demo/db`'s `applyDevSeed` adapter
 * operation. Reference data every environment needs is not seed content:
 * the migrations insert it (ADR 0038).
 */
import { applyDevSeed } from '@offense-demo/db/dev-seed';
import { agentSeedUsers, agentSeedVersion } from './agent-seed';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');

await applyDevSeed({
  url,
  seed: {
    name: 'agent',
    version: agentSeedVersion,
    people: agentSeedUsers,
  },
});

process.stdout.write(`Seed version: ${agentSeedVersion}\n`);

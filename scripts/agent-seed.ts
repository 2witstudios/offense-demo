export const agentSeedVersion = 'agent-seed-v1';

/**
 * The local development users `bun db:seed` writes (and `bun dev:agent`
 * prints), each with its own actor. IDs are fixed cuid2-shaped values so
 * reseeding is byte-identical. Bump `agentSeedVersion` whenever this
 * content changes. Product fixtures belong next to the product's own
 * persistence operations, not here.
 */
export const agentSeedUsers = [
  {
    userId: 'k2v9x0f4m8q3w1z7c5n6b4d2',
    actorId: 'h3j7m1p5r9t2v6x0z4b8d2f6',
    username: 'agent-alice',
  },
  {
    userId: 'a7b3c9d1e5f2k4m6n8p1r3t5',
    actorId: 'q5s9u3w7y1a4c8e2g6j0l4n8',
    username: 'agent-bob',
  },
] as const;

/**
 * `bun scripts/staging-restore-seed.ts`: AUTH-7.6's synthetic staging
 * content. Staging held no rows at all when the restore rehearsal needed
 * one, so this script creates a representative slice through the same `applyDevSeed`
 * adapter operation `bun db:seed` uses, plus the auth rows `applyDevSeed`
 * does not cover (sessions, verification tokens, passkeys) by direct
 * insert. Every value is synthetic: fixed cuid2-shaped ids, `@example.test`
 * addresses (RFC 2606, never delivered) and placeholder WebAuthn material —
 * never real personal data, and never anyone's real inbox. Idempotent in
 * row identity, like `applyDevSeed`: rerunning creates no new row (`ON
 * CONFLICT DO NOTHING`/`DO UPDATE` throughout, always on a fixed `id`) —
 * the session and verification rows' credential columns (`token`,
 * `identifier`, `value`) are the exception, deliberately refreshed to a new
 * CSPRNG value on every run rather than held fixed, so no rerun can ever
 * reintroduce a stable, guessable credential.
 *
 * Only ever point this at an isolated database: staging's own
 * `offense_demo_staging` for the rehearsal's synthetic source rows, never
 * production. The URL-string check (`refusalForStagingSeed`) runs before
 * any connection opens, but a `?database=` query parameter on the same
 * URL overrides which database Bun's `SQL` client actually connects to
 * (standard libpq connection-string behavior), so after connecting this
 * also checks `current_database()` — the server's own answer, which a
 * connection string cannot lie about — before `applyDevSeed`'s first
 * write.
 */
import { SQL } from 'bun';
import { applyDevSeed } from '@offense-demo/db/dev-seed';
import { refusalForActualName, refusalForStagingSeed } from './restore-guard';
import { emailedLinkIdentifier, randomSeedToken } from './restore-seed-token';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const force = process.argv.slice(2).includes('--force');
const refusal = refusalForStagingSeed(url, force);
if (refusal) throw new Error(refusal);

const restoreSeedVersion = 'restore-rehearsal-seed-v1';

const people = [
  {
    userId: 'r1s2t3u4v5w6x7y8z9a0b1c2',
    actorId: 'd3e4f5g6h7i8j9k0l1m2n3o4',
    username: 'restore-rehearsal-a',
    email: 'restore-rehearsal-a@example.test',
    emailVerified: true,
  },
  {
    userId: 'p5q6r7s8t9u0v1w2x3y4z5a6',
    actorId: 'b7c8d9e0f1g2h3i4j5k6l7m8',
    username: 'restore-rehearsal-b',
    email: 'restore-rehearsal-b@example.test',
    emailVerified: true,
  },
] as const;

const probe = new SQL(url, { max: 1 });
try {
  const [row] = (await probe`select current_database() as name`) as Array<{
    name: string;
  }>;
  const actualRefusal = refusalForActualName(row!.name, 'staging', force);
  if (actualRefusal) throw new Error(actualRefusal);
} finally {
  await probe.close();
}

await applyDevSeed({
  url,
  seed: {
    name: 'restore-rehearsal',
    version: restoreSeedVersion,
    people: [...people],
  },
});

// Sessions, verification tokens and passkeys: not part of applyDevSeed's
// adapter operation, so inserted directly. Placeholder WebAuthn material
// only ever needs to satisfy the schema, never a real ceremony.
const client = new SQL(url, { max: 1 });
try {
  for (const [index, person] of people.entries()) {
    // A fresh CSPRNG token every run, never bound to a name that outlives
    // this expression: a session row needs its `token` column to hold
    // something, but nothing about it needs to be derivable from source or
    // stable across reruns — only the row's `id` does, for `ON CONFLICT`.
    await client`
      insert into session (id, expires_at, token, ip_address, user_agent, user_id)
      values (
        ${`restore-seed-session-${index}`},
        now() + interval '7 days',
        ${randomSeedToken()},
        '198.18.0.1',
        'restore-rehearsal-seed',
        ${person.userId}
      )
      on conflict (id) do update set
        expires_at = excluded.expires_at,
        token = excluded.token,
        ip_address = excluded.ip_address,
        user_agent = excluded.user_agent
    `;
    await client`
      insert into passkey (
        id, name, public_key, user_id, credential_id, counter,
        device_type, backed_up, transports, aaguid
      )
      values (
        ${`restore-seed-passkey-${index}`},
        'Restore rehearsal synthetic passkey',
        'restore-rehearsal-placeholder-public-key',
        ${person.userId},
        ${`restore-seed-credential-${index}`},
        0,
        'singleDevice',
        false,
        'internal',
        null
      )
      on conflict (id) do update set
        public_key = excluded.public_key,
        credential_id = excluded.credential_id
    `;
  }
  // The token is generated only to be hashed into `identifier` on the next
  // line, then discarded: never bound to a name that outlives this
  // expression, never logged, never stored. Only its SHA3-256 digest goes
  // into the row, so nothing in this repository or its history can ever
  // redeem it.
  await client`
    insert into verification (id, identifier, value, expires_at)
    values (
      'restore-seed-verification-0',
      ${emailedLinkIdentifier('sign-in', randomSeedToken())},
      ${JSON.stringify({ email: people[0].email, name: null })},
      now() + interval '5 minutes'
    )
    on conflict (id) do update set
      identifier = excluded.identifier,
      value = excluded.value,
      expires_at = excluded.expires_at
  `;
} finally {
  await client.close();
}

process.stdout.write(`Restore rehearsal seed version: ${restoreSeedVersion}\n`);

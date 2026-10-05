# 0023: Greenfield baseline over backward compatibility

Status: accepted. Amended by [ADR 0038](0038-drizzle-1-baseline.md): the
second baseline squash is drizzle-kit 1.0's `20260923195259_baseline`, and a
sanction now records `baseMigrationsHash`, the fingerprint of the replaced
migrations tree, instead of the drizzle-kit 0.x journal.

Offense Demo is pre-ship and greenfield. No deployed environment has ever persisted
data against this repository's schema or contracts, so there is no durable
truth to preserve and no consumer to keep working. When a foundational choice
proves to be a mistake before first ship, the correct fix is removal, not
compatibility: rewrite the baseline, delete the compatibility surface, and
supersede the documenting ADR. Preserving a mistake is itself a cost — extra
validation grammar at trust boundaries, extra tests, extra policy entries, and
permanent cognitive overhead — paid forever for something nobody depends on.

This decision superseded ADR 0022 (legacy durable identifier compatibility,
removed from the template) and applied its principle retroactively to the
UUID-era migrations:

- The migrations `0000_optimal_calypso`, `0001_zippy_shen`, and
  `0002_auth_persistence` were squashed into a single cuid2-native baseline
  (`0000_unknown_harpoon`). Every identifier column is `text` holding cuid2;
  the uuid-to-text conversion, the case-folded username migration guard, and
  the legacy-journal replay fixtures no longer exist.
- `@offense-demo/protocol` validates exactly one identifier shape — cuid2
  (`^[a-z0-9]{24}$`). Canonical lowercase UUIDs are rejected at the trust
  boundary like any other non-conforming input.
- The immutability of applied migrations remains the default rule
  (see `docs/operations/database.md`). History rewrite is allowed only through
  a policy-file entry (`policy/migration-baselines.json`) that records the
  fingerprint of the replaced journal, references an ADR, and expires. A
  sanction is inert once the squashed baseline lands on the default branch,
  because no later branch can match the recorded fingerprint.

Pre-ship judgment calls of this kind are cheap and reversible in a way
post-ship compatibility is not. After first ship, normal expand/contract,
forward-only migration discipline applies without exception.

Acceptance criteria:

- Given the repository's migration directory, should contain exactly one
  squashed cuid2-native baseline migration, with no uuid columns and no
  migration-time guards, that later forward-only migrations build on.
- Given an identifier that is not 24-characters lowercase alphanumeric,
  should be rejected by `@offense-demo/protocol` with no legacy carve-out.
- Given a branch that rewrites committed migration history, should fail
  `bun migrations:check` unless a fingerprint-matched, ADR-linked,
  unexpired sanction exists in `policy/migration-baselines.json`.
- Given a local or test database predating the squash, should be unusable
  until reset once via `bun db:reset` (dev data is expendable pre-ship).

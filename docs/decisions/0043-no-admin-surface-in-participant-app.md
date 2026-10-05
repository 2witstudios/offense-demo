# 0043: no admin screens or admin-only routes in the participant app

Status: accepted (builder decision; implements owner decisions of
2026-09-25 on the admin plane).

Adapted for the template from the project it was extracted from.

## Context

The owner decided that operators will use a future, separate admin app: its
own deployable, its own database, its own accounts, reachable over a
private network only. Participant data changes from that app go through a
signed internal API on the participant app, private network only, audited
on both sides; the admin app never holds participant database credentials.
Roles and two-person approval are designed in from the start but switched
on later, with the owner as the only operator at first. The admin app
itself is out of scope here — it is deferred to its own epic.

Two things get more expensive the longer they wait:

1. A `role_grants` value named `admin` that nothing authorizes on invites
   a future grant into a role no code path checks, so it is removed from
   `grantRoles`, the CHECK constraint and every fixture.
2. Nothing stops an admin screen or admin-only route from landing in
   `apps/web` before the admin app exists. Every day that surface could
   grow makes the eventual removal larger and the migration to the signed
   internal API harder to land cleanly.

`AGENTS.md` already requires privileged operations to be pure domain
operations taking an explicit principal (dependency injection over ambient
authority). That contract is what lets a future signed internal API wrap
those operations without the participant app ever growing its own
privileged UI.

## Decision

1. **The participant app (`apps/web`) hosts no admin screens and no
   admin-only routes.** Privileged operations stay pure domain operations
   with an explicit principal; a route in the participant app never
   branches into an operator-only view. When the admin app lands, it calls
   these same operations through a signed internal API (private network
   only, audited on both sides), never by growing a
   parallel UI here.
2. **A committed mechanical check enforces this.** `adminSurfaceIssue` in
   `scripts/boundaries-rules.ts`, wired into the architecture scan
   (`scripts/check-boundaries.ts`, part of `bun check`'s boundaries gate),
   fails on any path under `apps/web/src/` with a segment named `admin`
   (a route, plain or grouped, e.g. `admin` or `(admin)`, or a feature
   directory or module file such as `admin.ts`). Unit tests in
   `scripts/check-boundaries.test.ts` are the negative fixture: they prove
   the check fires on route, feature and module examples, and does not
   false-positive on unrelated names such as `administration.ts`.
3. **`role_grants` keeps only the roles the participant app authorizes
   on.** `grantRoles` lists only roles that act inside the participant
   app (product roles such as a moderator); `admin` never becomes a
   `role_grants` value. The admin role lives in the future admin app's own
   database and accounts, never as a participant account with a grant.

## Consequences

- A future admin app PR that tries to add an admin route or screen to
  `apps/web` fails `bun check` at the boundaries gate, not at review time.
- The admin app's authorization model is designed later, in its own epic,
  against its own database; this ADR only forecloses admin surface leaking
  into the participant app before that model exists.
- Any privileged operation the future admin app needs must already exist,
  or be added, as a pure domain operation taking an explicit principal —
  never as UI-embedded logic in `apps/web`.

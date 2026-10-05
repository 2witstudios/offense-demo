# 0048: The authorization core

Status: accepted (owner-approved plan of 2026-09-29), rewritten 2026-09-30
before first ship (ADR 0023). The evaluator has landed (2026-10-05); the
service rule, `authorizeInbox` and the realtime composition are deferred
to their first consumer. Amends [ADR 0031](0031-realtime-service.md)
section 5 and [ADR 0019](0019-token-secret-ownership.md) (the `denyReason`
log field).

Adapted for the template from the project it was extracted from. Amended
2026-10-05: the evaluator has landed. The template ships the vocabulary
(`@offense-demo/protocol`), `authorize` and `toAuthorizationInput` (`@offense-demo/auth`),
`loadAuthorizationContext` (`@offense-demo/db`), `authorizeRequest` and the page
read path (`apps/web`), wired to the example `project` aggregate with two
capabilities, `project.create` and `project.list`. The flat permission list
is gone (section 5). What is deferred to its first consumer, and what
stands in for it until then, is listed in "What ships and what is
deferred" at the end.

## Context

Every access question (an HTTP page, an API read, a realtime subscribe, a
UI hint) has to be answered the same way, from facts loaded fresh per
request. Scattered `if (user.id === row.createdBy)` checks drift apart, leak
existence through different error codes, and cannot be property-tested. A
flat permission list on the principal answers "may this user do X at all",
never "may this user do X to this row".

## Decision

### 1. The model

| Concept    | What it is                                                                                     | Where it lives             |
| ---------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| Principal  | Who is asking: `anonymous` or `user` (`service` arrives with its first consumer)               | `@offense-demo/auth`       |
| Capability | A closed vocabulary of things that can be asked (`project.create`, `project.list`, …)          | `@offense-demo/protocol`   |
| Resource   | What it is asked of, by kind (`projects`, …), built from rows loaded by id                     | `@offense-demo/db` loader  |
| Context    | Facts about the principal and the resource (membership, creator, deny facts)                   | `@offense-demo/db` loader  |
| Decision   | `authorize({ principal, capability, resource, context })` returns allow, or deny with a reason | `@offense-demo/auth`, pure |

The rules of the model:

- **Identity, place and authority are separate questions.** The principal
  answers who is asking, the resource's rows answer what it is, and grants
  (none exist yet) answer what authority the principal holds.
- **The resource comes from rows loaded by id,** never from client input.
  A client-supplied visibility flag or owner id is ignored.
- **A principal carries no permissions.** A user's allowances come from
  the rules and the loaded facts. A service principal, when its first
  consumer adds it, holds a fixed capability list.
- **No platform scope inside `apps/web`.** The operator plane is a separate
  future admin app ([ADR 0043](0043-no-admin-surface-in-participant-app.md)).

### 2. Vocabulary (`@offense-demo/protocol`)

Capabilities are a const array with a derived zod enum and per-capability
metadata: `resourceKinds` lists what the capability can be asked of, and
`read` says whether it is a read capability. The template ships the first
two rows, for the example `project` aggregate in `@offense-demo/domain`; a product
adds rows. `room.read` is illustrative, the shape of a row kind a product
adds with its first table, and the room examples below use it.

| Capability       | `resourceKinds` | Read | Allowed by                                                   |
| ---------------- | --------------- | ---- | ------------------------------------------------------------ |
| `project.create` | `projects`      | no   | a signed-in member (shipped)                                 |
| `project.list`   | `projects`      | yes  | a signed-in member (shipped)                                 |
| `room.read`      | `room`          | yes  | (illustrative) the room's visibility, creator and membership |

- **Resource kinds:** `projects` ships. It is the collection, the resource
  asked when creating or listing: `{ kind: 'projects' }`. A kind naming
  one row (`project`, `room`) is loaded by id and arrives with its table.
- **Deny reasons:** `denied` (invalid resource kind), `account-erased`,
  `unauthenticated`, `missing-capability`. Every value has privacy category
  `none`, and the union is the `denyReason` log vocabulary.
- **Grant scopes:** none in the template. A product that needs delegated
  authority adds grant tables, scopes and the capabilities that read them
  together, with an ADR.

### 3. The evaluator (`@offense-demo/auth`, pure)

```text
authorize({ principal, capability, resource, context }) →
  { allow: true } | { allow: false, reason }
```

`authorizeInbox({ principal, inboxUserId, denyFacts })` follows the same
shape and lands with the first realtime consumer (section 6).

**The rules, in order. The reason is that of the first rule that decides.**

0. **Resource kind.** If `resource.kind` is not in the capability's
   `resourceKinds`, deny with `denied`. This guard sits at the top of
   `authorize`, so nothing below can allow such a request.
1. **Deny facts.** If a deny fact is present, deny with that fact
   (`account-erased` when the principal's user is tombstoned). Rule 0 runs
   first, so for a valid (capability, resource kind) pair a deny fact
   dominates every allowance, including membership and creation.
2. **Service.** For a service principal, allow if and only if its scope
   matches the resource and it holds the capability; otherwise deny with
   `missing-capability`. Rule 3 never applies to services. Deferred: the
   template has no service principal, so the input principal is
   `anonymous | user`, and this rule lands with the first service.
3. **Fixed allowances** (code, not data): each capability's rule over the
   resource and context. Shipped: a signed-in member may `project.create`
   and `project.list`. Illustrative: `room.read` on a `public` or
   `unlisted` room for everyone, and on a `private` room for its creator
   and members.
4. **Otherwise deny,** with `unauthenticated` for an anonymous principal and
   `missing-capability` in every other case.

A creator or member fact allows capabilities on **that** resource only.
`authorizeInbox` allows if and only if the principal is a user whose
`userId` equals `inboxUserId` and no deny fact is present.

**Public results.** The delivery layer maps them, and the mapping never
depends on the reason:

- A denied **read** capability returns `NOT_FOUND` for every principal,
  anonymous included, so no existence oracle is exposed. A resource that
  does not exist returns the same `NOT_FOUND`.
- A denied **non-read** capability returns `AUTHENTICATION` for an
  anonymous principal and `AUTHORIZATION` for everyone else.
- A **provisional** account (verified, no username yet) holds no member
  allowance. An API route answers it `AUTHORIZATION` for a non-read and
  `NOT_FOUND` for a read, before loading. A guarded page never reaches a
  decision for it: `requireAccess` has already redirected it to
  onboarding.
- An `unavailable` identity (the session store is down) never reaches
  `authorize`: `authorizeRequest` answers the existing 503 first, and a
  realtime subscribe fails closed with the unavailable error, not a denial.
- The reason goes only to the `denyReason` log field.

**Gates.** Every operation authorizes exactly one gate before any other
check or protected read. Topic gates:

| Topic                 | Gate                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `room:<id>`           | `room.read` on the room                                               |
| `room:<id>:presence`  | `room.read` on the room                                               |
| `room:<id>:chat`      | `room.read` on the room, and for a `private` room the member fact too |
| `user:<userId>:inbox` | `authorizeInbox`                                                      |

**Properties.** The template proves them with tests exhaustive over the
closed input space (principal kind × capability × resource kind, plus one
forged kind outside the vocabulary × deny facts), which stand in for a
generated property suite while the space is this small. A product whose
facts make the space open (memberships, creators, scopes) adds property
tests over generated inputs:

- **Deny dominance:** with `account-erased` present, every capability asked
  of a resource kind in its `resourceKinds` is denied with `account-erased`.
- **Resource kinds:** no capability is ever allowed for a resource kind
  outside its `resourceKinds`.
- **Fact locality:** creator and member facts change decisions about their
  own resource only. (No such fact ships; it lands with the first.)
- **Service scope:** a service is never allowed outside its scope.
  (Deferred with rule 2.)

### 4. Schema

The evaluator adds no table. Resource tables carry the columns their rules
read (visibility, creator, membership); the first product table brings
them with its own migration.

### 5. Loader and composition

The loader is shared by `apps/web` and `apps/realtime`, and neither app may
import the other (ADR 0031 section 12). `@offense-demo/db` may not import
`@offense-demo/auth`. So the composition has three parts:

- **`loadAuthorizationContext(db, { userId, resourceRef })`** lives in
  `@offense-demo/db` (`packages/db/src/authorization/`). It returns a plain,
  structurally typed projection of rows and facts, with no `@offense-demo/auth`
  types: the resource by id (`{ kind: 'projects' }` needs no row), the
  principal's membership and creator facts when a product adds them, and
  `users.deleted_at` for the `account-erased` fact. `userId` is null for an
  anonymous principal; a user id with no row fails closed as
  `account-erased`. It keeps no cross-request cache and selects only
  columns the runtime role that calls it may read: `offense_demo_web` reads
  `users`; `offense_demo_realtime` has no `users` grant yet, so the first realtime
  consumer's migration grants it `SELECT (id, deleted_at)`. It is exposed
  as `database.loadAuthorizationContext`.
- **`toAuthorizationInput(projection, principal)`** is a pure mapper in
  `@offense-demo/auth` that builds the resource and context `authorize` takes.
- Each app composes the two: `apps/web` in `authorizeRequest`,
  `apps/realtime` in its subscribe decision (section 6).

**`authorizeRequest(identity, capability, resourceRef)`** takes the
identity, not the bare principal, because the 503 and the provisional
answer need its state. It first answers the existing 503 for an
`unavailable` identity, without loading or deciding, and refuses a
provisional account before loading (section 3). Otherwise it loads, calls
`authorize`, logs a denial as `authz.denied` with `denyReason`, and throws
the public error (section 3) or returns the loaded resource. It is the
only way an operation reaches a protected read. `createAuthorizeRequest`
in `apps/web/src/server/authorize-request.ts` binds it to the loader and
the operation's logger.

**Identity.** `resolveIdentity` produces no permissions, `Principal` has
none, and the permission helpers and the unused `service` variant were
deleted with their tests in the change that added the evaluator, a total
transition (ADR 0023).

**Reading data in a page.** A server component reads through the API
route the browser would call, in process: `readRoute` in
`apps/web/src/lib/request-route.ts` calls the bound handler with
`inProcessFetch` and the request's own headers, so `authorizeRequest`
gates page reads too ([UI conventions](../development/ui-conventions.md#reading-data-in-a-page)).

**UI capability projection.** The server runs `authorize` for the
capabilities a page needs and passes only booleans to client components
(for example `{ canCreateProject }`). Loaded rows and deny facts never reach
the browser, and a page never computes an access decision on the client.

### 6. Realtime subscribe

Deferred to the first realtime consumer; this section is the design it
implements. `apps/realtime` declares `@offense-demo/auth`. `authorizeSubscribe(topic,
principal, input)` is pure, lives in `@offense-demo/auth`, and maps each topic
family to one decision (the gate table in section 3). A denied or failed
decision refuses the subscribe.

- Sockets require a ticket, and tickets are issued only to signed-in
  users, so an anonymous principal never subscribes.
- **`unlisted` is a listing flag, not access control.** An unlisted
  resource is left out of listings, but anyone who has its id may read it.
  cuid2 ids are identifiers, never bearer secrets (AGENTS.md), so privacy
  requires `private`.
- Periodic re-authorization calls the same composition and fails closed: a
  recheck that cannot run drops the subscription. Session revalidation
  covers erasure (`session.revoked`) and ended sessions.

### 7. Package ownership and edges

| Package                  | Owns                                                                                                            | Edge change                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `@offense-demo/protocol` | Capabilities, resource kinds, deny reasons, topic vocabulary and parsing                                        | none                                                    |
| `@offense-demo/auth`     | `authorize`, `toAuthorizationInput`, principal and resource types; later `authorizeInbox`, `authorizeSubscribe` | `['errors']` became `['errors', 'protocol']`            |
| `@offense-demo/db`       | `loadAuthorizationContext` (`packages/db/src/authorization/`)                                                   | none                                                    |
| `@offense-demo/logger`   | `denyReason` in `loggableFields`                                                                                | none                                                    |
| `apps/web`               | `authorizeRequest` and the pages and API routes that call it                                                    | none                                                    |
| `apps/realtime`          | Composes the loader and `authorizeSubscribe` for the subscribe registry                                         | declares `@offense-demo/auth` (already an allowed edge) |

The `auth → protocol` edge is in `scripts/boundaries-rules.ts` and
`packages/auth/package.json`, and the package map in
`docs/architecture/overview.md` describes it.

### 8. Security essentials

Each essential has a test that fails when it is removed:

| Essential                                                                                      |
| ---------------------------------------------------------------------------------------------- |
| Rule 0: resource kind checked before any allowance                                             |
| The resource comes from rows loaded by id (the loader ignores client-supplied flags)           |
| Gate before any protected read (an operation reaching a read without `authorizeRequest` fails) |
| `NOT_FOUND` for every denied read, anonymous included                                          |
| `account-erased` dominance                                                                     |
| Service scope never crossed                                                                    |
| Boolean-only UI projection (props test)                                                        |
| Same-origin refusal on every new mutating route                                                |
| An `unavailable` identity answers 503 (HTTP) or fails closed (realtime), never a denial        |
| Every topic family decided by `authorizeSubscribe`                                             |
| Exhaustive tests on the pure core (standing in for the property suite, section 3)              |

## Amendments to earlier records

### ADR 0031 section 5

The per-family subscribe table is replaced by section 6's rules: every
topic family goes through `authorizeSubscribe`, and `unlisted` is a listing
flag.

### ADR 0019

The log field `denyReason` joins the loggable fields, with kind code and
the vocabulary of section 2's deny reasons, every value privacy category
`none`. It is added to `loggableFields` and ADR 0019's table in one change,
under the drift guard.

## Consequences

- Every access question has one pure answer, and a denied read is
  indistinguishable from a missing resource.
- Adding a product feature means adding capability rows, a resource kind,
  loader columns and fixed-allowance rules, each covered by the property
  suite, rather than inventing a new check.
- A change that deviates from this record updates the record first.

## What ships and what is deferred

Shipped with the template:

- The vocabulary (`project.create`, `project.list`, `projects`, the four
  deny reasons), `authorize` with rules 0, 1, 3 and 4,
  `toAuthorizationInput`, `loadAuthorizationContext`, `authorizeRequest`,
  `readRoute`, the `authz.denied` event and the `denyReason` field.
- Exhaustive tests over the closed input space for deny dominance and
  resource-kind safety, standing in for the property suite.

Deferred, each to its first consumer, which brings it with its tests:

- Rule 2, the `service` principal and the service-scope property.
- `authorizeInbox`, `authorizeSubscribe` and the realtime composition
  (section 6), with the `offense_demo_realtime` grant on `users (id, deleted_at)`.
- Row resource kinds and their creator and member facts, with fact
  locality property tests.
- The UI capability projection's first boolean.

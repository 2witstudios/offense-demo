# 0048: The authorization core

Status: accepted (owner-approved plan of 2026-09-29), rewritten 2026-09-30
before first ship (ADR 0023). Amends [ADR 0031](0031-realtime-service.md)
section 5 and [ADR 0019](0019-token-secret-ownership.md) (the `denyReason`
log field).

Adapted for the template from the project it was extracted from. The template ships the
decision; the first product capability lands with the evaluator. Until
then, `@offense-demo/auth`'s identity carries the flat permission list it started
with, and the first change that adds a capability replaces it in one move
(section 5).

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
| Principal  | Who is asking: `anonymous`, `user`, or `service`                                               | `@offense-demo/auth`       |
| Capability | A closed vocabulary of things that can be asked (`room.read`, `room.create`, …)                | `@offense-demo/protocol`   |
| Resource   | What it is asked of, by kind (`room`, …), built from rows loaded by id                         | `@offense-demo/db` loader  |
| Context    | Facts about the principal and the resource (membership, creator, deny facts)                   | `@offense-demo/db` loader  |
| Decision   | `authorize({ principal, capability, resource, context })` returns allow, or deny with a reason | `@offense-demo/auth`, pure |

The rules of the model:

- **Identity, place and authority are separate questions.** The principal
  answers who is asking, the resource's rows answer what it is, and grants
  (none exist yet) answer what authority the principal holds.
- **The resource comes from rows loaded by id,** never from client input.
  A client-supplied visibility flag or owner id is ignored.
- **A principal carries no permissions.** A service principal holds a fixed
  capability list; a user's allowances come from the rules and the loaded
  facts.
- **No platform scope inside `apps/web`.** The operator plane is a separate
  future admin app ([ADR 0043](0043-no-admin-surface-in-participant-app.md)).

### 2. Vocabulary (`@offense-demo/protocol`)

Capabilities are a const array with a derived zod enum and per-capability
metadata: `resourceKinds` lists what the capability can be asked of, and
`read` says whether it is a read capability. A product adds rows; the
example below is illustrative.

| Capability    | `resourceKinds` | Read | Allowed by (example)                               |
| ------------- | --------------- | ---- | -------------------------------------------------- |
| `room.create` | `rooms`         | no   | any signed-in user                                 |
| `room.read`   | `room`          | yes  | the room's visibility, its creator and its members |

- **Resource kinds:** `room | rooms` in the example. `rooms` is the
  resource asked when creating one: `{ kind: 'rooms' }`.
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
authorizeInbox({ principal, inboxUserId, denyFacts }) →
  { allow: true } | { allow: false, reason }
```

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
   `missing-capability`. Rule 3 never applies to services.
3. **Fixed allowances** (code, not data): each capability's rule over the
   resource and context, for example `room.read` on a `public` or
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
  anonymous principal, the onboarding redirect for a provisional user, and
  `AUTHORIZATION` for everyone else.
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

**Properties**, proven by property tests over generated principals,
resources and contexts:

- **Deny dominance:** with `account-erased` present, every capability asked
  of a resource kind in its `resourceKinds` is denied with `account-erased`.
- **Resource kinds:** no capability is ever allowed for a resource kind
  outside its `resourceKinds`.
- **Fact locality:** creator and member facts change decisions about their
  own resource only.
- **Service scope:** a service is never allowed outside its scope.

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
  types: the resource by id, the principal's membership and creator facts,
  and `users.deleted_at` for the `account-erased` fact. It keeps no
  cross-request cache and selects only columns both runtime roles may
  read.
- **`toAuthorizationInput(projection, principal)`** is a pure mapper in
  `@offense-demo/auth` that builds the resource and context `authorize` takes.
- Each app composes the two: `apps/web` in `authorizeRequest`,
  `apps/realtime` in its subscribe decision (section 6).

**`authorizeRequest(principal, capability, resourceRef)`** first answers
the existing 503 for an `unavailable` identity, without loading or
deciding. Otherwise it loads, calls `authorize`, logs a denial with
`denyReason`, and throws the public error (section 3) or returns the loaded
resource. It is the only way an operation reaches a protected read.

**Identity.** When the evaluator lands, `resolveIdentity` stops producing
permissions, `Principal` loses `permissions`, and the permission helpers are
deleted with their tests in the same change, a total transition (ADR 0023).

**UI capability projection.** The server runs `authorize` for the
capabilities a page needs and passes only booleans to client components
(for example `{ canCreateRoom }`). Loaded rows and deny facts never reach
the browser, and a page never computes an access decision on the client.

### 6. Realtime subscribe

`apps/realtime` declares `@offense-demo/auth`. `authorizeSubscribe(topic,
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

| Package                  | Owns                                                                                                      | Edge change                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `@offense-demo/protocol` | Capabilities, resource kinds, deny reasons, topic vocabulary and parsing                                  | none                                                    |
| `@offense-demo/auth`     | `authorize`, `authorizeInbox`, `authorizeSubscribe`, `toAuthorizationInput`, principal and resource types | `['errors']` becomes `['errors', 'protocol']`           |
| `@offense-demo/db`       | `loadAuthorizationContext` (`packages/db/src/authorization/`)                                             | none                                                    |
| `@offense-demo/logger`   | `denyReason` in `loggableFields`                                                                          | none                                                    |
| `apps/web`               | `authorizeRequest` and the pages and API routes that call it                                              | none                                                    |
| `apps/realtime`          | Composes the loader and `authorizeSubscribe` for the subscribe registry                                   | declares `@offense-demo/auth` (already an allowed edge) |

The `auth → protocol` edge is added in `scripts/boundaries-rules.ts` and
`packages/auth/package.json` by the change that adds the evaluator, and the
package map in `docs/architecture/overview.md` describes it.

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
| Property suite on the pure core                                                                |

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
- Until the evaluator lands, the code still carries the flat permission
  list. A change that deviates from this record updates the record first.

# 0031: Realtime service

Status: accepted. Uses the extraction seam of [ADR 0003](0003-modular-monolith.md);
builds on [ADR 0012](0012-native-bun-infrastructure.md). The delivery path
(outbox, cursors, drain) is the outbox ADR's (0032) and presence and
attendance are the presence ADR's (0033); this record fixes only the service
and its socket protocol. Section 5 is amended by
[ADR 0048](0048-authorization-core.md).

Adapted for the template from the project it was extracted from.

## Context

Offense Demo needs live updates: room changes pushed to the people in a room,
presence, and later chat and notifications. Without this service there is no
transport. PageSpace, which we studied, runs a separate
socket.io service that grew into a PTY bridge, voice host and preview proxy,
checked auth only at the handshake, and let socket.io's silent drop of
unknown events force a "deploy realtime first" rule.

ADR 0003 ships one deployable application but designs extraction seams so
that "a future realtime or matchmaking service is a new deployment of
existing contracts, not a rewrite". Correctness in this epic does not live
in the socket: clients send every command over HTTP to `apps/web`, the
transactional outbox is the delivery log, and clients recover from their own
cursors. The socket is a doorbell channel that may drop at any time.

## Decision

### 1. Scope: a second deployment with four jobs

`apps/realtime` is a second deployment in this monorepo, built from the
existing contracts (ADR 0003's seam). Its scope is exactly:

1. authenticate sockets;
2. authorize subscriptions;
3. fan out outbox rows to subscribed sockets;
4. social presence (advisory Redis leases, ADR 0033).

Excluded, as decisions:

- **No domain logic.** It never imports `@offense-demo/domain`, never decides a
  domain outcome, and never writes durable product state. Its PostgreSQL
  role is SELECT-only (ADR 0032 §7); the only write it may ever gain is its
  own instance lease row.
- **No video or media.** Media never passes through this WebSocket; a media
  service would be a separate deployment with its own ADR.
- **No jobs.** Email, web push and sweeps run elsewhere
  (`apps/web` maintenance or a job queue with its own ADR).
- **Nothing else.** A new responsibility (a proxy, a bridge, a worker) goes
  to another service; adding one here requires superseding this ADR.

### 2. Transport: native `Bun.serve` WebSocket

The transport is Bun's native WebSocket on `Bun.serve` (uWebSockets). No
socket.io, no Engine.IO, and no client library: the browser uses its native
`WebSocket`. No dependency is added, so `docs/dependencies.md` is unchanged.

#### Spike (2026-09-22)

A throwaway spike (kept outside the repository, per the task) exercised both
candidates on Bun 1.4.2, macOS arm64 (Apple M1 Max), against
version-matched sources: the `bun-types@1.4.2` package that the repository
installs (`docs/runtime/http/websockets.mdx`, `serve.d.ts`), and the
installed `@socket.io/bun-engine@0.1.2` README and source with
`socket.io@4.8.3` / `socket.io-client@4.8.3`. The spike used placeholder
application codes (4401, 4408) and a shortened 300 ms `hello` timer; the
normative values are in sections 8 and 11.

| Question                                   | Native `Bun.serve` (measured)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | socket.io + `@socket.io/bun-engine` 0.1.2 (measured)                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topics                                     | `ws.subscribe`, `server.publish`, `subscriberCount`: 2 of 3 sockets subscribed, only those 2 received the row                                                                                                                                                                                                                                                                                                                                                                                     | Rooms work, fanned out in JavaScript by the adapter                                                                                                                                                                                                                                                           |
| Fan-out, 200 subscribers × 2,000 doorbells | 400,000 delivered in 190 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 400,000 delivered in 3,356 ms (about 17× slower)                                                                                                                                                                                                                                                              |
| Slow consumer (reader paused)              | Without `closeOnBackpressureLimit`, `server.publish` returned 0 (dropped) for 361 of 400 publishes while the socket stayed subscribed. With it, the socket closed (1006)                                                                                                                                                                                                                                                                                                                          | By default, 944 of 2,000 room emits silently lost; the socket stayed connected and kept receiving afterwards. The engine ignores `send()`'s status and `engine.handler()` sets no backpressure bound; the documented manual wiring can set `closeOnBackpressureLimit`, which turns the loss into a 1006 close |
| App-coded close under backpressure         | `ws.close(4408, …)` when `getBufferedAmount()` exceeded 256 KiB: the client received 4408 and the reason after resuming                                                                                                                                                                                                                                                                                                                                                                           | Server disconnect reaches the client only as the string `"io server disconnect"`; no application close codes                                                                                                                                                                                                  |
| Transports                                 | WebSocket only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `GET /socket.io/?EIO=4&transport=polling` answered 200 with a session id: long-polling is on by default (`TRANSPORTS = ["polling", "websocket"]`); the documented `allowRequest` hook can refuse it (403)                                                                                                     |
| `maxPayloadLength`                         | Oversize inbound message closes the socket; the client saw 1006, not the 1009 the `close()` docs list                                                                                                                                                                                                                                                                                                                                                                                             | `maxHttpBufferSize`, same underlying limit                                                                                                                                                                                                                                                                    |
| `idleTimeout`                              | A silent socket closed at 7,998 ms (`idleTimeout: 8`) and 32,004 ms (`32`). Values round up to 4 s (`10` closed at 12,000 ms; `1` never fired in 6 s), and a close can land up to 2 s early (30,011 ms at `32` under load, in review)                                                                                                                                                                                                                                                             | Sets the HTTP `idleTimeout`, not the WebSocket one                                                                                                                                                                                                                                                            |
| `sendPings`                                | Timed on the server: with `sendPings: true`, a reader-paused peer (zero pongs) was closed at 8,004 ms (`idleTimeout: 8`) and 36,028 ms (`36`); a live peer sending no application messages stayed open past 45 s on protocol pongs alone. A peer that stops reading but keeps sending is not idle and is reaped only by the backpressure bounds (section 9). (A first, client-side-only measurement reported "stayed open"; a paused client cannot observe the close, and the review refuted it.) | Engine.IO's own 25 s ping / 20 s timeout                                                                                                                                                                                                                                                                      |
| Per-message compression                    | `perMessageDeflate: true` negotiated `permessage-deflate; server_no_context_takeover; client_no_context_takeover`                                                                                                                                                                                                                                                                                                                                                                                 | Not configurable through the engine                                                                                                                                                                                                                                                                           |
| Client cost                                | 0 bytes (native `WebSocket`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `socket.io-client` minified 49,812 B, 15,759 B gzipped                                                                                                                                                                                                                                                        |
| Maturity                                   | Part of the pinned runtime (ADR 0001)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Pre-1.0 engine (0.1.2)                                                                                                                                                                                                                                                                                        |

socket.io showed no capability Offense Demo requires that the native path lacks:
its reconnection, acks, adapters and fallback transports are either owned by
this design (cursors, request ids, the outbox) or forbidden by it (polling).
It showed a concrete defect for Offense Demo: silent loss to a slow consumer that
stays connected by default. Its polling and backpressure defaults can be
worked around (`allowRequest`, manual wiring), but a workaround does not add a
capability native lacks. **Native is selected.**

### 3. WebSocket only, never long-polling

Long-polling spreads one logical connection over many HTTP requests that
must reach the same instance, which needs sticky sessions.
`docs/operations/production.md` says sticky sessions are "not part of any
design", so realtime accepts only WebSocket upgrades on one path and answers
every other request to that path with 400. Polling would also spend the
browser's six-connections-per-host budget. A client that cannot open a
WebSocket still works: every command and every read is HTTP, and nothing
durable ever depends on the socket.

### 4. Commands go over HTTP; the socket accepts five messages

Every client command (a room action, a chat send, a reaction) goes over
HTTP to `apps/web`, which keeps its idempotency, validation and rate
limits. The socket accepts exactly these client messages, and
nothing else:

| `type`              | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `hello`             | first message: `{protocolVersion, ticket}`                     |
| `subscribe`         | `{id, topic, since?}`: join a topic, catching up from a cursor |
| `unsubscribe`       | `{id, topic}`: leave a topic                                   |
| `presence.activity` | `{activity: 'active' \| 'idle'}` for this connection's lease   |
| `ping`              | `{id}`: application heartbeat                                  |

### 5. Subscribe authorization table

_(Amended by [ADR 0048](0048-authorization-core.md).)_ Every `subscribe` is
decided by one pure function, `authorizeSubscribe`, owned by `@offense-demo/auth`
and built on the authorization core's evaluator. The topic vocabulary and
parsing stay in `@offense-demo/protocol` (`parseTopic`, `topics.ts`), while every
decision belongs to `@offense-demo/auth`. The subscribe registry performs no
authorization logic of its own: it loads the facts a rule needs from
`@offense-demo/db`'s read models (rows loaded by id, never client input), then asks
the evaluator. A topic family absent from the table is refused, and so is a
decision that fails or cannot run (fail closed).

| Topic family                                        | Rule                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `room:<id>`, `room:<id>:presence`, `room:<id>:chat` | a valid ticket, plus the authorization core's room read decision (the room's visibility and the user's membership) |
| `user:<userId>:inbox`                               | the owning user only, matched against the connecting ticket's `userId`                                             |

A product may narrow a family further (for example, chat for members only)
in the evaluator, never in the registry. cuid2 ids are identifiers, never
bearer secrets, so a room that must be private is private by its
visibility rule, not by the secrecy of its id.

Subscriptions are re-authorized in a batch every 60 s, the same period as
session revalidation (section 11). Every socket may also hold at most a
bounded number of active subscriptions, **64 per socket by default**;
`@offense-demo/config`'s validated environment owns the exact bound, configurable
from that default (`apps/realtime`'s concern, not this package's), so a
client cannot force unbounded per-socket authorization work by subscribing
without limit.

**Implemented today:** the topic grammar, the message schemas and the
`hello` path (ticket consumption, the 5 s deadline, close codes). The
subscribe registry, the evaluator call, the drain loop and the ring are
decided here and in ADR 0032 but not yet built; `apps/realtime/src/socket.ts`
states the same.

### 6. The envelope

Every message in both directions is a JSON text frame
`{v, type, id?, ...fields}`:

- `v` is the envelope version (`ENVELOPE_VERSION`, the integer `1`):
  wire framing only. `hello.protocolVersion` (`PROTOCOL_VERSION`)
  separately negotiates the message set and semantics; an unsupported one
  closes with `protocol_unsupported`. The two are distinct values, tracked
  by two separate `@offense-demo/protocol` constants that both happen to start at
  `1` rather than one constant reused under two names, so either can change
  without forcing the other.
- `type` is the discriminant. `@offense-demo/protocol` owns one zod discriminated
  union for client messages and one for server messages, and the close-code
  table; TypeScript types are inferred from the schemas.
- `id` is a client-chosen request id, present on requests that expect a
  reply (`subscribe`, `unsubscribe`, `ping`). The server answers with the
  same `id`: `subscribed`, `unsubscribed`, `resync_required` or `error` for
  subscriptions, `pong` for `ping`. Server-initiated messages (`ready`
  after `hello`, `event`, `presence.changed`, `revoked`,
  `server.restarting`) carry no `id`.
- The receiving side always runs `safeParse`, server and client. An inbound
  message that fails to parse, or any message before a successful `hello`,
  is rejected loudly by closing the socket; nothing is silently dropped.
  An unparseable first message closes with `4003 protocol_unsupported`,
  not `4001`: parsing runs before authentication, so a client that cannot
  speak the protocol is told not to reconnect rather than to fetch a new
  ticket.
- Frames are text, not binary. Inbound frames are capped by
  `maxPayloadLength: 4096` bytes (a `hello` with its ticket is under 300);
  Bun closes an oversize frame abruptly (measured: 1006).

Server messages, exactly:

| `type`              | Fields beyond `{v, type}`    | Purpose                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribed`        | `{id, topic, position}`      | acknowledges `subscribe`; `position` is the outbox cursor to catch up from                                                                                                                                                                                        |
| `unsubscribed`      | `{id, topic}`                | acknowledges `unsubscribe`                                                                                                                                                                                                                                        |
| `resync_required`   | `{id, topic}`                | the requested `since` fell before the retained range; reload over HTTP                                                                                                                                                                                            |
| `error`             | `{id?, code, message}`       | a request-scoped or connection-scoped error                                                                                                                                                                                                                       |
| `pong`              | `{id}`                       | answers `ping`                                                                                                                                                                                                                                                    |
| `event`             | `{topic, position, payload}` | an outbox row fanned out to a subscriber; `payload.kind` is one of the doorbell or inbox kind names ADR 0032 §6 lists                                                                                                                                             |
| `presence.changed`  | `{topic}`                    | the presence doorbell (ADR 0033 §1): a `room:<id>:presence` topic's projected value changed. No `position`: presence is never written to the outbox, so there is nothing to carry beyond the topic, and the client always refetches the projected value over HTTP |
| `ready`             | none                         | `hello` succeeded                                                                                                                                                                                                                                                 |
| `revoked`           | none                         | `session.revoked`, or the 60 s revalidation found the session gone                                                                                                                                                                                                |
| `server.restarting` | none                         | SIGTERM drain                                                                                                                                                                                                                                                     |

### 7. Heartbeat: application `ping` every 15 s

Browsers cannot send WebSocket ping frames, so client-side liveness is an
application message; server-side reaping uses the protocol's own pings:

- The client sends `ping` every 15 s and expects `pong` with the same `id`.
  It measures misses by elapsed time since the last `pong` (dead after 30 s
  without one), not by counting timer ticks, and it also pings at once on
  `visibilitychange` to visible. Chromium throttles chained timers in tabs
  hidden for more than 5 minutes to about once a minute; judging by elapsed
  time plus the visibility ping keeps a throttled tab from declaring a
  healthy socket dead or from missing a dead one for long after it becomes
  visible. A socket deemed dead is closed and reconnected with its
  cursors.
- The server keeps Bun's default `sendPings: true` with `idleTimeout: 36`
  seconds, as the plan specifies. Timed on the server, a peer that neither
  sends nor answers pings is closed at `idleTimeout` (8,004 ms at `8`,
  36,028 ms at `36`), and a live browser answers protocol pings without
  running JavaScript, so a throttled hidden tab is not reaped. A peer that
  stops reading but keeps sending is not idle; the backpressure bounds
  (section 9) reap it once traffic flows to it, and until then it holds at
  most its bounded buffer.
- `idleTimeout` fires on a 4 s tick and was measured up to 2 s early
  (30,011 ms at `32` under load). `32` would leave only 0–2 s over two
  heartbeats (30 s); `36` is chosen so a client whose only traffic is its
  15 s `ping` keeps at least 4 s of margin even if a pong round is lost.
- The heartbeat period feeds the reconnect allowance
  `heartbeatMs * 2 + reconnectBudgetMs` (ADR 0033 §6): any grace window a
  product sizes against a dropped socket must cover it, so a change to the
  15 s period is a change to that allowance.
- `heartbeatMs` (15 000) is a named `@offense-demo/protocol` constant, and
  `reconnectBudgetMs` (10 000) joins it in the change that adds its first
  consumer (ADR 0033 §6), so both read one value. `idleTimeout` (36, Bun's seconds unit, not
  milliseconds) is Bun server tuning, so it lives in `apps/realtime`'s
  socket wiring, not the portable protocol.

### 8. Close codes

`@offense-demo/protocol` owns the close-code table, in the 4000–4999 application
range. The client reacts per code:

| Code | Name                   | Server closes when                                                                                    | Client reaction                                                                                               |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 4001 | `auth_failed`          | no `hello` within 5 s; bad, expired, replayed or origin-mismatched ticket; any message before `hello` | fetch a fresh ticket and reconnect with backoff; after 3 consecutive failures, stop and show signed-out state |
| 4002 | `revoked`              | `session.revoked`, or the 60 s revalidation finds the session gone                                    | do not reconnect; refetch the session over HTTP                                                               |
| 4003 | `protocol_unsupported` | `hello.protocolVersion` unsupported, or an inbound message (including the first) fails to parse       | do not reconnect; ask the user to reload                                                                      |
| 4004 | `rate_limited`         | connection or inbound-message rate limit exceeded                                                     | reconnect with jittered backoff from a 30 s floor                                                             |
| 4005 | `slow_consumer`        | the socket's send buffer passed the soft bound (section 9)                                            | reconnect with jitter and resubscribe from cursors                                                            |
| 4006 | `server_restarting`    | SIGTERM drain                                                                                         | reconnect with 0–5 s jitter (another instance takes it)                                                       |

Transport-level closes the client also handles: `1000` (normal) and `1001`
(going away) reconnect only if still wanted; `1006` (abnormal: network loss,
Bun's hard backpressure limit, an oversize frame, `idleTimeout`) reconnects
with jittered exponential backoff and no lifetime ceiling on clean
reconnects. An unknown code is treated as `1006`.

### 9. Slow-consumer policy

Correctness never depends on the socket, so the server never buffers without
bound; it closes and lets the client catch up from its cursor. Measured
basis: `server.publish` returns one status for all subscribers and drops for
a backpressured one without closing it, so a silent gap is possible unless
the server closes.

- **Hard bound (backstop):** `backpressureLimit: 1 MiB` with
  `closeOnBackpressureLimit: true`. Bun closes the socket (the client sees 1006) instead of dropping while subscribed. This is what guarantees no
  silent gap.
- **Soft bound (coded close):** after each drain batch fans out, and after
  every direct `send`, the server checks `getBufferedAmount()` of the
  affected sockets and closes any above 256 KiB with `4005 slow_consumer`.
  A direct `send` returning `0` (dropped) also closes with 4005.
- Doorbells are about 100 bytes, so 256 KiB is thousands of undelivered
  rows: a socket that far behind is cheaper to resync than to feed.
- Both bounds are server tuning owned by `apps/realtime`'s socket wiring:
  the 1 048 576-byte hard backstop is set there, and the 262 144-byte
  coded-close bound is added with the send path that enforces it.

### 10. Compression off

`perMessageDeflate` is disabled. Payloads are ~100-byte doorbells, so
compression costs per-socket CPU and memory for no gain, and compressing
owner-only deltas next to attacker-influenced bytes invites a
CRIME/BREACH-style length oracle. Revisit only with a topic whose frames
exceed 1 KiB, in a superseding ADR.

### 11. First-message tickets

A socket is authenticated by a single-use ticket sent in its first message,
never in the URL (browsers cannot set headers on a WebSocket, and a query
string lands in proxy and access logs):

1. `apps/web` issues it from `POST /api/realtime/ticket` for the caller's
   verified session. The route is same-origin and rate-limited.
2. The ticket is 32 bytes from the OS CSPRNG (`crypto.getRandomValues`),
   base64url-encoded. It is a bearer secret, so it is never a cuid2.
3. Only its SHA3-256 hash is stored, in Redis under a namespaced
   `ticket` key with a 60 s TTL, bound to `{userId, sessionId, origin}`.
   The plaintext exists only in the HTTP response and the `hello` frame.
4. The upgrade checks `Origin` against a fail-closed allowlist and the
   per-IP rate limit, caps unauthenticated sockets per IP, and accepts the
   socket **unauthenticated**. The client IP comes from ADR 0025's
   trusted-proxy rule (the ingress-overwritten `x-offense-demo-client-ip`, with
   `AUTH_TRUSTED_PROXIES` for the first untrusted `X-Forwarded-For` hop;
   absent an identity, one shared fail-safe bucket). Both apps share one
   implementation of that rule, so no client-writable header is ever
   trusted.
5. The first message must be `hello {protocolVersion, ticket}` within 5 s.
   The server hashes the ticket and consumes it atomically with a new
   `@offense-demo/redis` GETDEL operation, so a replay finds nothing. The binding's
   `origin` must equal the upgrade's `Origin`, and the session must still be
   valid. Any failure, or the 5 s timer, closes with `4001 auth_failed`
   (spike: a silent socket closed at 313 ms against a 300 ms timer, and a
   pre-`hello` `subscribe` closed with the app code).
6. Until `hello` succeeds, the socket can do nothing else. The session is
   revalidated every 60 s and on `session.revoked`, and subscriptions are
   re-authorized in batch every 60 s.

Tickets, raw frames and payloads are never logged; logs carry event names,
connection and user ids, and close codes (ADR 0019).

### 12. Allowed edges

`apps/realtime` may depend on exactly:

| Workspace                     | For                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `@offense-demo/protocol`      | envelope, message and outbox schemas, close codes, topic grammar               |
| `@offense-demo/auth`          | principals and session-to-identity resolution                                  |
| `@offense-demo/db`            | SELECT on the outbox and authorization read models; `service_instances` writes |
| `@offense-demo/redis`         | ticket GETDEL, presence leases, rate limits                                    |
| `@offense-demo/clock`         | injected time (ambient `Date` is banned)                                       |
| `@offense-demo/config`        | validated environment                                                          |
| `@offense-demo/errors`        | error codes and public mapping                                                 |
| `@offense-demo/logger`        | structured, redacted logs                                                      |
| `@offense-demo/observability` | spans, correlation, bounded health checks                                      |

It never depends on `@offense-demo/domain`, `apps/web` or a third-party socket
library. The package-map row in `docs/architecture/overview.md`
states the same list. `scripts/check-boundaries.ts` restricts workspaces
listed in `allowedWorkspaceDependencies` (`scripts/boundaries-rules.ts`);
`realtime` entry names exactly these workspaces (an edge is declared in
`apps/realtime/package.json` only once code uses it; `@offense-demo/auth` joins with
the subscribe registry), so the row is mechanically enforced rather than
advisory. The `@offense-demo/db` restriction to SELECT is enforced by the realtime
PostgreSQL role, not by the import graph.

## Consequences

- We own four small protocol pieces instead of a library: the envelope, the
  heartbeat, the close codes and the slow-consumer policy. Each is a schema
  or a constant in `@offense-demo/protocol` and is covered by the realtime
  integration runner (a real `Bun.serve` with a real WebSocket client).
- There is no fallback transport. A network that blocks WebSocket gets no
  live updates but loses nothing durable, because commands and reads are
  HTTP.
- Multi-instance fan-out needs no adapter and no Redis pub/sub: each
  instance drains the outbox itself (ADR 0032).
- A second deployable needs a deploy target, routing and secrets; that is a
  human-only decision and `docs/operations/production.md` is updated when
  it is made. Realtime exposes its own `/health/live` and `/health/ready`
  (ready checks PostgreSQL, LISTEN and Redis) and drains on SIGTERM with
  `4006 server_restarting`.
- The browser needs no client dependency; the connection store lives in
  `apps/web/src/features/realtime/`, and outbox pruning runs in the web
  server's one retention sweep.

### Recorded conflicts

- **ADR 0003, "one deployable application".** This ADR adds a second
  deployment. ADR 0003 names a realtime service as the intended use of its
  seams, so this record relies on that sentence rather than overriding it;
  the amendment to ADR 0003's text is the outbox ADR's (0032), not this
  one's.
- **Process-local state.** `docs/architecture/overview.md` ("State and
  runtime semantics") and `docs/operations/production.md` ("stateless
  except pools/logger/draining") describe `apps/web`. Realtime also holds
  open sockets, their subscriptions, the drain cursor and a small ring of
  recently fanned-out rows in process memory. All of it is rebuilt on
  restart (clients reconnect with their cursors; the instance cursor starts
  at the high-water mark), so no coordination state is process-only, but
  those documents describe `apps/web` only.

## Amendment (2026-09-29): subscribe decisions

[ADR 0048](0048-authorization-core.md) makes `authorizeSubscribe` in
`@offense-demo/auth` the single decision for every topic family (section 5 states
the result). The topic vocabulary stays in `@offense-demo/protocol` and the decision
is `@offense-demo/auth`'s. The 60 s re-authorization batch, the per-socket bound and
the revocation messaging are unchanged.

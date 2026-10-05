# AUTH-6.7 load harness

Proves criteria 2 and 4 of AUTH-6.7 (throughput/latency and the 80/10/10
workload). Criteria 1 and 3 (cross-instance correctness, restart and outage
recovery) are deterministic integration proofs instead:
`apps/web/integration/auth-cross-instance.integration.ts` and
`apps/web/integration/auth-outage-recovery.integration.ts`.

## What it runs

Two real production `createApp` instances (`instance-process.ts`, spawned
twice by `two-instances.ts`) over one shared `DATABASE_URL` and
`REDIS_NAMESPACE`, behind one shared self-signed TLS edge that round-robins
every request across them — one public origin, no sticky session, matching
the topology described in the leaf. 50 simulated clients (real distinct
`X-Forwarded-For` identities, trusted only because they arrive through the
harness's own loopback hop named in `AUTH_TRUSTED_PROXIES` — never a header
a real caller could set for itself) each rotate the shipped 80/10/10 mix
across their own request sequence, admitted at a fixed target rate for the
run's duration, against the real mounted routes, the real shipped rate
limiter and origin checks, and pre-enrolled real WebAuthn software
credentials for the passkey-assertion segment.

## Running locally

```sh
bun slot:up                                  # once per checkout
bun --cwd apps/web run build                 # a production Next build must exist
bun --cwd apps/web run load:local -- --duration-seconds=30 --clients=6 --target-rps=6
bun --cwd apps/web run load:abuse
```

A local run reuses this checkout's own e2e database, Redis namespace and
`offense_demo_e2e` credential (`local-services.ts`) — the same isolated,
non-development-marked services `bun test:e2e` uses (AUTH-6.1) — instead of
provisioning anything new. **Never run this at the same time as
`bun test:e2e` in the same checkout**: both would share the database, Redis
namespace and rate-limit buckets. `bun slot:reset-e2e` clears the run's data
afterward.

Defaults (`bun --cwd apps/web run load:local` with no flags) are the leaf's
documented baseline: 600 seconds, 50 clients, 20 admitted requests/second,
50 pre-signed-in session accounts, 10 pre-enrolled passkey accounts. **This
machine is heavily shared** (AGENTS.md): running the full ten-minute
baseline, or anything sustained, needs the same go-ahead as a staging run
below — a short `--duration-seconds` dry run is safe to run freely.

## Staging

**Ask before sending any load at staging — this is a deploy-rail action
(the task prompt's explicit instruction).** The harness has no `--base-url`
provisioning path wired yet (see Limitations); running the criteria against
staging needs that wiring plus a private mail sink staging can reach, both
of which are additional scope pending that go-ahead.

## Report

`run.ts` writes `reports/<timestamp>-<label>/report.json` and `report.md`:
workload parameters, population, max concurrent in-flight requests, p50/p95/
p99 server-observed latency, the unexpected-5xx rate, the success rate, and
a full outcome tally (offered / successful / rejected by status / timed out
/ unexpected failure) per workload segment and overall. `abuse-run.ts`
writes a companion report for the separate abusive/rate-limit assertion
(AC4: "Run abusive/rate-limit load separately and assert the expected
429s") — 30 simultaneous magic-link requests from one simulated client
under real concurrent two-instance HTTP load, asserting exactly 3 are
admitted and the rest answer 429 with `Retry-After`.

## Honest limits and design notes

- **The magic-link segment sits at the shipped global ceiling's edge.** 10%
  of a 20 req/s baseline is 2 req/s of fresh-address magic-link requests —
  exactly the shipped `MAGIC_LINK_GLOBAL_RULES` 120/60s ceiling (ADR 0025),
  which meters only addresses with no account, i.e. every request this
  segment sends. A sustained run this close to a real, deliberately
  conservative security ceiling will occasionally answer 429 on that
  segment even with nothing wrong; the report's `magic-link` breakdown makes
  this visible rather than hiding it inside the overall success rate, and the
  success-rate threshold itself is computed over _admitted_ traffic (offered
  minus only the magic-link segment's own deliberate 429s), never against
  those 429s, so this expected behavior cannot fail the run on its own (AC4:
  "report deliberate 429s ... separately"). A 429 storm on session-read or
  passkey-assertion is a real capacity failure, not this expected ceiling
  behavior, and stays counted against the 99% bar (`metrics.ts`'s
  `successRate`, ISSUE-165). This is a property of the two numbers
  the spec fixes together (the 20 req/s baseline and the 80/10/10 split),
  not a defect in the harness or the limiter — record it plainly when this
  run's evidence is reviewed, and do not lower the workload split or the
  ceiling to make it disappear.
- **No `--base-url` provisioning path yet.** `run.ts` refuses a `--base-url`
  run today because provisioning needs a private mail sink it does not yet
  know how to reach on a deployed target (staging's real Resend delivery has
  no local capture endpoint). Wiring a staging-reachable private mailbox is
  additional scope, gated on the same owner go-ahead as sending load at
  staging at all.
- **`apps/web/e2e/support/tls-edge.ts` and `mail-capture.ts`** were
  extracted from `e2e/support/server.ts` (behavior-preserving) so this
  harness and the browser suite share one implementation of "a self-signed
  TLS edge in front of a production app" and "a private mail sink", per
  AGENTS.md's shared-abstractions rule (two real consumers).

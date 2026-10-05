# Decision records

Architecture decision records (ADRs) for Offense Demo. Each records the context,
the decision, its tradeoffs and its consequences. Code comments and other
documents cite records by number ("ADR 0031 §5"), so numbers are permanent:
a record is amended in place (naming the amending ADR in its `Status:`
line) or marked superseded, never renumbered. Take a new number from
`bun adr:next` and add a row here in the same change.

Most records were adapted from the project this template was extracted
from; those whose content changed materially say so under their status.

## Index

| ADR                                                                 | Decision                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [0001](0001-bun-runtime.md)                                         | Bun is the only runtime and package manager, pinned and upgraded deliberately                           |
| [0002](0002-workspaces-turborepo.md)                                | Bun workspaces with a Turborepo task graph                                                              |
| [0003](0003-modular-monolith.md)                                    | One modular monolith with designed extraction seams; no microservices, event sourcing or message bus    |
| [0004](0004-nextjs-delivery.md)                                     | Next.js is the delivery layer only, never the domain                                                    |
| [0005](0005-framework-independent-domain.md)                        | The domain (`@offense-demo/domain`) is pure, deterministic and framework-free                           |
| [0007](0007-postgresql-source-of-truth.md)                          | PostgreSQL is the durable source of truth; conventions for ids, time and versions                       |
| [0008](0008-redis-ephemeral.md)                                     | Redis holds only expendable, expiring state through Bun's native client                                 |
| [0009](0009-portable-protocol.md)                                   | `@offense-demo/protocol` owns portable, versioned JSON contracts                                        |
| [0010](0010-runtime-validation.md)                                  | Zod validates every trust boundary                                                                      |
| [0011](0011-documentation-first-dependencies.md)                    | Read version-matched official docs before adding or configuring a dependency                            |
| [0012](0012-native-bun-infrastructure.md)                           | Native Bun SQL and Redis adapters instead of extra drivers                                              |
| [0013](0013-knip-dead-code-gate.md)                                 | Knip is a required dead-code gate                                                                       |
| [0014](0014-riteway-testing-standard.md)                            | RITEway (`riteway/bun`) is the test format on Bun's runner                                              |
| [0015](0015-event-stream-as-observability-source-of-truth.md)       | The structured event stream is the observability source of truth                                        |
| [0016](0016-injected-clock-and-identity.md)                         | Clocks and id generators are injected, never ambient                                                    |
| [0017](0017-better-auth-passwordless.md)                            | Better Auth passwordless (magic link and passkey) behind a framework-free auth boundary                 |
| [0018](0018-cuid2-identifiers.md)                                   | Application-minted cuid2 identifiers; UUIDs only as documented exceptions                               |
| [0019](0019-token-secret-ownership.md)                              | Who owns each token and secret; the allowlisted log fields                                              |
| [0020](0020-auth-activation-gates.md)                               | Auth configuration is validated only when auth activates                                                |
| [0021](0021-repository-aidd-overrides.md)                           | Repository-specific overrides of generic AIDD guidance                                                  |
| [0023](0023-greenfield-baseline.md)                                 | Greenfield over backward compatibility before first ship; sanctioned baseline squashes                  |
| [0025](0025-auth-delivery-and-abuse-protection.md)                  | Auth mail delivery, single-use emailed-link tokens, rate limits and abuse protection                    |
| [0026](0026-duplication-gate.md)                                    | jscpd duplication gate with a shrink-only baseline                                                      |
| [0027](0027-theme-preference.md)                                    | Server-rendered `dark / light / system` theme preference in a cookie                                    |
| [0028](0028-tailwind-v4.md)                                         | Token-locked Tailwind CSS v4 under the strict CSP                                                       |
| [0031](0031-realtime-service.md)                                    | `apps/realtime`: native `Bun.serve` WebSocket service, tickets, envelope, heartbeat and subscribe rules |
| [0032](0032-transactional-outbox-delivery.md)                       | Transactional outbox in PostgreSQL feeds realtime delivery; doorbell payloads                           |
| [0033](0033-presence.md)                                            | Advisory presence in Redis leases; PostgreSQL time for durable facts; reconnect allowance               |
| [0034](0034-shared-stack-slots.md)                                  | One shared local stack with derived per-checkout slots and per-run test databases                       |
| [0036](0036-privacy-by-design.md)                                   | Privacy classification, scoped identifiers, data inventory, subject rights and consent                  |
| [0037](0037-error-tracking-and-product-analytics.md)                | Error tracking and analytics only through scrubbed, inert-by-default adapters                           |
| [0038](0038-drizzle-1-baseline.md)                                  | Drizzle 1.0 and the single baseline that owns roles, rules and reference data                           |
| [0039](0039-dated-dependency-audit-exceptions.md)                   | `bun audit` in CI with dated, reviewed exceptions                                                       |
| [0040](0040-sha-pinned-actions.md)                                  | GitHub Actions pinned to commit SHAs; secrets scoped to their step                                      |
| [0041](0041-migration-credential-in-a-release-only-app.md)          | The migration credential lives in a release-only Fly app                                                |
| [0042](0042-auth-alert-evaluation-point.md)                         | Auth alerts are evaluated by a probe outside the app                                                    |
| [0043](0043-no-admin-surface-in-participant-app.md)                 | No admin screens or admin-only routes in `apps/web`; admins get a separate app                          |
| [0044](0044-recipient-hash-secret-independent-of-session-secret.md) | The recipient-hash key is independent of the session-signing secret                                     |
| [0046](0046-auth-alert-probe-cadence-correction.md)                 | The auth alert probe's Actions schedule is best-effort; no new scheduler                                |
| [0048](0048-authorization-core.md)                                  | One pure authorization evaluator over a closed capability vocabulary                                    |
| [0050](0050-local-development-terminal-mailer.md)                   | Local development prints auth mail to the terminal when Resend is unset                                 |

## Intentionally absent numbers

0006, 0022, 0024, 0029, 0030, 0035, 0045, 0047 and 0049 are missing on
purpose. They recorded product-specific decisions of the project this
template was extracted from (its domain runtime, schema, rules, brand and
vendors) or were superseded there, and were not carried into the template.
Do not reuse these numbers: `bun adr:next` hands out the next number after
the highest one in use.

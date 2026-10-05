## Change

What problem does this solve, and what behavior changes?

## PageSpace

Links a reviewer needs to check this change against what was asked (use `/pr`). “none” only for work with no task.

- Tasks:
- Plan:
- Prompt:
- Handoff:
- Reviews: pending independent review

Builder: <your pu agent id (PU_AGENT_ID), or "owner">

The `Builder:` line is what the review-record check compares against the
review record's reviewer; a PR without it cannot get the status.

## Criteria

| Criterion | Code | Test | Evidence |
| --------- | ---- | ---- | -------- |

## Validation

Commands run and results. Explain unavailable checks.

## Operational impact

Migration/deployment order, configuration changes, rollback constraints, or “none”.

## Architecture

Affected ownership boundaries and ADR/dependency documentation updates, or “none”.

## Privacy & telemetry

See [ADR 0036](docs/decisions/0036-privacy-by-design.md),
[ADR 0037](docs/decisions/0037-error-tracking-and-product-analytics.md) and
[privacy](docs/operations/privacy.md). “none” only when this change adds no
log field, database/Redis column, `outbox.payload` kind, realtime topic
payload field, or analytics event.

- Columns and fields classified here (category, visibility, purpose,
  lawful basis, retention, erasure) until `bun privacy` (PRIV-3) exists to
  gate `data-inventory.ts` directly:
- Log events registered (registry entry), including any new
  `outbox.payload` kind or realtime topic-family payload field (an
  analytics event registry is deferred to PRIV-6):
- No personal data in telemetry (no `personal`, `sensitive` or `secret`
  field reaches a log, error report or analytics event; an
  `outbox.payload` kind or realtime topic message carries a
  `personal`/`public` value only once classified in the inventory, never a
  `personal`/`private`, `sensitive` or `secret` value):
- Retention and erasure defined for any new personal-data column:
- Consent category declared for any new client-side tracking:

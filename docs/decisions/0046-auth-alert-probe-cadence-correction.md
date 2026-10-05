# 0046: The auth alert probe's GitHub Actions schedule runs best-effort, not every 5 minutes — no new scheduler

Status: accepted (owner decision 2026-09-28).
Amends [ADR 0042](0042-auth-alert-evaluation-point.md), which chose GitHub
Actions' `schedule` trigger as the evaluator and accepted, as a _known
limitation_, that "GitHub's `schedule` trigger is best-effort and can run a
few minutes late under platform load." That assumption was false at the
granularity the five-minute cadence relied on; this ADR corrects the measured facts and
records the owner's resolution: **keep the GitHub-scheduled probe exactly as
built, and accept its real, best-effort cadence for staging.** No new
scheduler, no new Fly machine, no in-app evaluator. The workflow's
schedule, the accepted probe cadence and its cost are unchanged; the
probe's error handling and the explanatory comments do change.

## Context (measured)

`gh run list --workflow auth-alerts.yml` on `main` shows 15 runs across
~43.5 hours, 2–5 hours apart, against a `cron: '*/5 * * * *'` schedule. This
is not "a few minutes late" — the workflow ran at roughly 1–2% of its
configured cadence. In that time, only the `cleanup_missed` condition (a
2-hour threshold) has ever fired live; `storage_unavailable` and
`limiter_unavailable` (2-minute thresholds, even after
[the probe error-handling fix](../operations/auth-delivery.md#storage-or-rate-limiter-unavailable)
that keeps their since-time alive through a continuous outage) and
`auth_5xx_rate` (10-minute window) are essentially unobservable at this real
cadence unless independently triggered and checked between scheduled runs
(as the original live-trigger evidence did, using
`workflow_dispatch` rather than waiting on the schedule).

GitHub documents this directly: "the schedule event can be delayed during
periods of high loads... The delay can be as much as 15 minutes, or even
longer if there's an outage affecting GitHub Actions" (source below) — and
the measured 15-run sample shows delays far past even that stated ceiling.
`schedule` was never designed for sub-hour reliability at scale; ADR 0042
under-estimated how far short of 5 minutes it would fall.

The probe's cadence bears only on detection latency, not on cost or on
whether the machine runs: `offense-demo-staging` runs continuously under
an owner decision (`fly.toml`'s `min_machines_running = 1` and
`auto_stop_machines = "off"`, about $3.99/month). Between real runs, hours
apart, a condition can fire and resolve with no probe to see it.

## Options considered

Two real fixes exist for a genuine 5-minute cadence — an in-app
evaluator (an evaluation loop inside the always-on app, the Incidents
webhook secret added to the production app's own environment) or a dedicated always-on Fly machine running only the external
prober. Both are deploy-rail or new-cost changes AGENTS.md reserves for the
owner; both were presented to the owner and both were
**declined**.

## Decision

**The owner's decision (2026-09-28): neither option. Keep the
GitHub-scheduled probe and accept its best-effort cadence (runs can be
hours apart).** The five-minute cadence figure is amended to
best-effort for staging; the cadence requirement is satisfied by this
decision, not by a new scheduler. The scheduler question is revisited before any
production launch, where a genuinely reliable cadence would matter more
than it does for a staging-only alerting exercise.

**Practical consequence:** the 2-minute and 10-minute alert windows will
continue to lapse between scheduled runs most of the time; only
`cleanup_missed` (2-hour threshold) reliably survives the real gap. Proving
`storage_unavailable`, `limiter_unavailable`, `auth_5xx_rate` and
`delivery_failures` therefore requires an independent live trigger plus a
`workflow_dispatch` run, not waiting on the schedule to
happen to catch a real occurrence.

## Consequences

- `docs/decisions/0042-auth-alert-evaluation-point.md`'s "Known
  limitations" section is corrected: GitHub's schedule is not "a few
  minutes late" at the observed 2–5 hour granularity — it is amended to
  state the real, accepted cadence.
- No schedule, `fly.toml`, or cadence change: the workflow's schedule, the
  probe's cadence, and its cost stay as ADR 0042 shipped them. (The probe's
  error handling changes separately, so an unreachable
  origin or alerts endpoint still posts to Incidents.)
- `.github/workflows/auth-alerts.yml`, `scripts/auth-alert-probe.ts` and
  `apps/web/src/features/ops/alerts.ts`'s docblocks are corrected to state
  the real cadence instead of "every 5 minutes."
- Revisit before a production launch, where the detection latency this
  cadence implies (hours, not minutes) may no longer be acceptable.

## Sources

- GitHub Actions `schedule` trigger delay:
  https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule
- Fly Machines `--schedule` granularity (hourly/daily/weekly/monthly only,
  confirmed via `fly machine run --help`, 2026-09-28):
  https://fly.io/docs/machines/flyctl/fly-machine-run/
- Fly.io `auto_stop_machines`/`auto_start_machines`/`min_machines_running`:
  https://fly.io/docs/reference/configuration/#the-http_service-section
- `gh run list --workflow auth-alerts.yml` (measured cadence, 2026-09-28).

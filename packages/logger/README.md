# @offense-demo/logger

Owner: Platform/observability (see CODEOWNERS scaffold).

Structured logger facade. Public API: createLogger, Logger, EventName and LogFields. Each log call uses one event from the closed platform vocabulary; the registry selects its severity, and runtime values outside that vocabulary degrade to `telemetry.unknown_event`. Callers cannot select levels directly. Only this package imports Pino. Log named identifiers, duration and stable codes; do not log arbitrary payloads, credentials, database URLs or raw errors. Redaction cannot protect secrets embedded inside strings.

Run `bun run typecheck` and `bun test src` from this package. Integration-enabled packages expose `bun run test:integration`; tests require explicit test infrastructure variables. All imports use the public package export.

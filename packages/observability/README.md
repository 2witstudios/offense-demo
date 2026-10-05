# @offense-demo/observability

Owner: Platform/observability (see CODEOWNERS scaffold).

Boundary spans, trace correlation, request IDs and bounded waits. Public API: withSpan, currentTraceId, requestId, withTimeout. Only this package imports OTel API. Deployment selects provider/exporter; without provider tracing is no-op. withTimeout does not cancel an underlying write. Use native statement timeouts and propagate AbortSignal in future transport APIs.

Run `bun run typecheck` and `bun test src` from this package. Integration-enabled packages expose `bun run test:integration`; tests require explicit test infrastructure variables. All imports use the public package export.

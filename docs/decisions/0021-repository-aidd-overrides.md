# 0021: repository-specific AIDD overrides

Status: accepted.

Repository instructions take precedence over generic generated guidance:

- Bun 1.4.2 and `riteway/bun` are the test/runtime standard, not Vitest.
- `@offense-demo/errors` and native `Error.cause` are the error standard, not
  `error-causes`.
- Durable behavior requires real PostgreSQL/Redis integration tests through the
  application operation; mocks alone are insufficient.
- Unit tests inject deterministic clocks and IDs; integration tests may use
  CSPRNG isolation IDs when sharing real services.

These overrides are enforced by the existing checks plus `bun policy`. They do
not add a second test, error, or state-management library.

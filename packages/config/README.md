# @offense-demo/config

Owner: Platform/application delivery (see CODEOWNERS scaffold).

Runtime trust-boundary schemas and explicit parsers. Public API: readServerConfig, readBrowserConfig, requireTestServices (the integration-suite guard) and serverConfigSchema. Depends only on Zod. Nothing reads process.env at module import. Never pass the server result to client components; use the browser allowlist.

Run `bun run typecheck` and `bun test src` from this package. Integration-enabled packages expose `bun run test:integration`; tests require explicit test infrastructure variables. All imports use the public package export.

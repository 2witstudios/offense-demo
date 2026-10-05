# 0014: RITEway test format on Bun's test runner

Status: accepted.

Tests are specifications: every assertion must state what behavior is
expected under what given conditions, and a failing test must read as a bug
report. Adopt RITEway (`riteway@9.3.0`) in its Bun-native form: tests import
`describe`, `test`, `assert` and `setupRitewayBun` from `riteway/bun`, call
`setupRitewayBun()` once per test file, and assert value contracts with
`assert({ given, should, actual, expected })`. The custom matcher prints
`Given <given>: should <should>` plus an expected/received diff, so the
failing assertion is the report. `bun test` remains the only runner and
Tiers 1–2 remain unchanged; `riteway/bun` is a thin, typed layer over
`bun:test`, so no second runner, watch mode or reporting stack enters the
repo.

Convention details: `given`/`should` are written as a specification
sentence, not prose decoration. An expected `AppError` is asserted by its
code with `assertRejects` (`@offense-demo/errors/testing`); `toThrow(message)` is
permitted only on other exception paths, and a bare `.toThrow()` never.
All existing suites are converted;
`packages/domain/src/project.test.ts` is the canonical example. New
tests follow TDD and land in the same change as the behavior they specify.
This decision constrains test form only; the tiering rules in
`docs/development/testing.md` stand unchanged. `riteway` is
declared as an exact devDependency in every workspace whose tests import it,
satisfying both the declared-dependency rule and the Knip gate.

References: [RITEway](https://github.com/ericelliott/riteway), [`riteway/bun`
entry point](https://github.com/ericelliott/riteway#bun), [Bun test
runner](https://bun.sh/docs/cli/test).

# TDD with RITEway

Tests are specifications, written first. Red, green, refactor — new behavior
lands with its tests in the same change. Never skip, disable or weaken a
test to get green; a flaky test is a bug.

## Format

Tests run on `bun test` and import `describe`, `test`, `assert` and
`setupRitewayBun` from `riteway/bun` (the Bun-native entry point of
`riteway`).

```ts
import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

describe('redisKey', () => {
  test('namespace is explicit and unambiguous', () => {
    assert({
      given: 'a namespace, domain and segment',
      should: 'compose the versioned key',
      actual: redisKey('{{name}}', 'presence', 'user-1'),
      expected: '{{name}}:v1:presence:user-1',
    });
    expect(() => redisKey('{{name}}', 'a:b')).toThrow();
  });
});
```

## Rules

- `setupRitewayBun()` is called once per test file, before assertions.
- Value contracts assert with `assert({ given, should, actual, expected })`.
- `expect(...).toThrow()` / `rejects.toThrow()` are allowed only on
  exception paths.
- `given`/`should` read as a specification sentence. When the test fails,
  its message is the bug report — write it for the person who will read it
  at 3 a.m.

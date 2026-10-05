import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { scanPolicyText } from './policy';
import {
  duplicateAdrNumberProblems,
  validateMigrationBaselines,
  validatePolicyRegistry,
} from './policy-registry';

setupRitewayBun();

describe('policy scanner: token-locked styling', () => {
  test('flags inline style attributes and style elements in shipped TSX', () => {
    assert({
      given: 'TSX using a style attribute, a string style, and a style element',
      should: 'report each as an inline-style finding',
      actual: scanPolicyText(
        'apps/web/src/ui/a.tsx',
        [
          'const a = <div style={{ width: 3 }} />;',
          "const b = <div style='width:3px' />;",
          'const c = <style>{css}</style>;',
        ].join('\n'),
      ).map(({ rule, line }) => `${rule}:${line}`),
      expected: ['inline-style:1', 'inline-style:2', 'inline-style:3'],
    });
  });

  test('leaves test TSX and plain TypeScript alone', () => {
    assert({
      given: 'a style attribute inside a test file and a TypeScript string',
      should: 'report nothing',
      actual: [
        ...scanPolicyText('apps/web/src/a.test.tsx', '<div style={{}} />'),
        ...scanPolicyText(
          'apps/web/src/a.ts',
          "const s = '<div style={{}} />';",
        ),
      ],
      expected: [],
    });
  });

  test('flags a silenced Tailwind lint rule', () => {
    assert({
      given: 'a comment disabling a better-tailwindcss rule',
      should: 'report tailwind-lint-disable',
      actual: scanPolicyText(
        'apps/web/src/ui/a.tsx',
        [
          '// eslint-',
          'disable-next-line better-tailwindcss/no-unknown-classes',
        ].join(''),
      ).map(({ rule }) => rule),
      expected: ['tailwind-lint-disable'],
    });
  });
});

describe('policy scanner', () => {
  test('detects direct random UUID generation and repository UUID contracts', () => {
    assert({
      given: 'application source using direct UUID generation and validation',
      should: 'report both policy rules',
      actual: scanPolicyText(
        'src/example.ts',
        'crypto.randomUUID();\nconst id = z.uuid();',
      ).map(({ rule }) => rule),
      expected: ['direct-random-uuid', 'repository-owned-uuid'],
    });
  });

  test('does not report unrelated identifiers', () => {
    assert({
      given: 'source using an injected identity',
      should: 'report no policy findings',
      actual: scanPolicyText('src/example.ts', 'const id = ids.next();'),
      expected: [],
    });
  });

  test('detects random UUID calls through aliased imports', () => {
    assert({
      given: 'application source importing randomUUID under a local alias',
      should: 'report the aliased call as direct random UUID generation',
      actual: scanPolicyText(
        'src/example.ts',
        "import { randomUUID as nextId } from 'node:crypto';\nconst id = nextId();",
      ),
      expected: [
        {
          path: 'src/example.ts',
          line: 2,
          rule: 'direct-random-uuid',
          detail: 'const id = nextId();',
        },
      ],
    });
  });

  test('rejects broad or unapproved exception entries', () => {
    assert({
      given: 'an exception with a wildcard path and unknown category',
      should: 'reject the registry entry instead of allowing the exception',
      actual: validatePolicyRegistry(
        {
          version: 1,
          exceptions: [
            {
              path: 'packages/*',
              rule: 'direct-random-uuid',
              category: 'local-ignore',
              owner: 'unknown',
              reason: 'not specific',
              adr: 'bad-reference',
              reviewBy: 'not-a-date',
            },
          ],
        },
        {
          knownPaths: new Set(['docs/decisions/0018-cuid2-identifiers.md']),
          today: '2026-09-20',
        },
      ),
      expected: [
        'registry[0]: wildcard paths are not allowed',
        'registry[0]: path does not exist: packages/*',
        'registry[0]: unknown category local-ignore',
        'registry[0]: invalid ADR reference bad-reference',
        'registry[0]: ADR does not exist: bad-reference',
        'registry[0]: reviewBy must be an ISO date',
      ],
    });
  });

  test('requires ADR and review fields', () => {
    assert({
      given: 'an exception without lifecycle metadata',
      should: 'reject missing ADR and review fields',
      actual: validatePolicyRegistry({
        version: 1,
        exceptions: [
          {
            path: 'src/example.ts',
            rule: 'direct-random-uuid',
            category: 'tooling',
            owner: 'platform',
            reason: 'fixture',
          },
        ],
      }),
      expected: [
        'registry[0]: adr is required',
        'registry[0]: reviewBy is required',
      ],
    });
  });

  test('rejects expired review dates', () => {
    assert({
      given: 'an exception whose review date is before today',
      should: 'require review before the exception can pass',
      actual: validatePolicyRegistry(
        {
          version: 1,
          exceptions: [
            {
              path: 'src/example.ts',
              rule: 'direct-random-uuid',
              category: 'tooling',
              owner: 'platform',
              reason: 'fixture',
              adr: 'docs/decisions/0018-cuid2-identifiers.md',
              reviewBy: '2026-09-19',
            },
          ],
        },
        {
          knownPaths: new Set([
            'src/example.ts',
            'docs/decisions/0018-cuid2-identifiers.md',
          ]),
          today: '2026-09-20',
        },
      ),
      expected: ['registry[0]: reviewBy has expired: 2026-09-19'],
    });
  });

  test('rejects duplicate exception entries', () => {
    const entry = {
      path: 'src/example.ts',
      rule: 'direct-random-uuid' as const,
      category: 'tooling' as const,
      owner: 'platform',
      reason: 'fixture',
      adr: 'docs/decisions/0018-cuid2-identifiers.md',
      reviewBy: '2026-09-20',
    };
    assert({
      given: 'two entries for the same path and rule',
      should: 'reject the duplicate exception',
      actual: validatePolicyRegistry(
        { version: 1, exceptions: [entry, entry] },
        {
          knownPaths: new Set([
            'src/example.ts',
            'docs/decisions/0018-cuid2-identifiers.md',
          ]),
          today: '2026-09-20',
        },
      ),
      expected: ['registry[1]: duplicate src/example.ts|direct-random-uuid'],
    });
  });
});

describe('migration baseline registry', () => {
  const knownPaths = new Set(['docs/decisions/0023-greenfield-baseline.md']);
  const validBaseline = {
    baseMigrationsHash: `sha256:${'a'.repeat(64)}`,
    adr: 'docs/decisions/0023-greenfield-baseline.md',
    owner: 'platform',
    reason: 'one-time cuid2-native baseline squash',
    reviewBy: '2026-09-20',
  };

  test('accepts a well-formed, unexpired sanctioned baseline', () => {
    assert({
      given: 'a baseline entry with a content hash, ADR and live review date',
      should: 'report no registry problems',
      actual: validateMigrationBaselines(
        { version: 1, baselines: [validBaseline] },
        { knownPaths, today: '2026-09-20' },
      ),
      expected: [],
    });
  });

  test('rejects malformed hashes, unknown ADRs and expired reviews', () => {
    assert({
      given:
        'baseline entries with a bare hash, missing ADR file and an expired review date',
      should: 'reject every entry with the specific registry problem',
      actual: validateMigrationBaselines(
        {
          version: 1,
          baselines: [
            { ...validBaseline, baseMigrationsHash: 'abc123' },
            {
              ...validBaseline,
              adr: 'docs/decisions/9999-missing.md',
              reviewBy: '2026-01-01',
            },
          ],
        },
        { knownPaths, today: '2026-09-20' },
      ),
      expected: [
        'baselines[0]: baseMigrationsHash must be sha256:<64 lowercase hex>',
        'baselines[1]: ADR does not exist: docs/decisions/9999-missing.md',
        'baselines[1]: reviewBy has expired: 2026-01-01',
      ],
    });
  });
});

describe('decision record numbering', () => {
  test('rejects two decision records sharing a numeric prefix', () => {
    assert({
      given: 'repository paths where two ADR files are both numbered 0017',
      should: 'report the shared number with every colliding file',
      actual: duplicateAdrNumberProblems([
        'docs/decisions/0016-injected-clock-and-identity.md',
        'docs/decisions/0017-ecs-ui-shell-state.md',
        'docs/decisions/0017-better-auth-passwordless.md',
        'docs/decisions/0018-cuid2-identifiers.md',
      ]),
      expected: [
        'decisions: ADR number 0017 is shared by docs/decisions/0017-better-auth-passwordless.md, docs/decisions/0017-ecs-ui-shell-state.md',
      ],
    });
  });

  test('accepts uniquely numbered records and ignores other paths', () => {
    assert({
      given:
        'uniquely numbered ADR files beside same-prefixed files outside docs/decisions',
      should: 'report no numbering problems',
      actual: duplicateAdrNumberProblems([
        'docs/decisions/0017-better-auth-passwordless.md',
        'docs/decisions/0024-ecs-ui-shell-state.md',
        'docs/decisions/README.md',
        'docs/decisions/archive/0017-nested.md',
        'packages/db/migrations/0017-example.md',
      ]),
      expected: [],
    });
  });
});

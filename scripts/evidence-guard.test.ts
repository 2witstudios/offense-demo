import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { integrationGuardProblems } from './evidence';

setupRitewayBun();

describe('integrationGuardProblems', () => {
  const guarded = [
    "import { requireTestServices } from '@offense-demo/config';",
    'const { databaseUrl } = requireTestServices(process.env);',
  ].join('\n');
  const codes = (content: string) =>
    integrationGuardProblems(content, 'db.integration.ts').map(
      ({ code }) => code,
    );

  test('accepts a suite that imports and calls the shared guard at load', () => {
    assert({
      given:
        "a suite calling @offense-demo/config's requireTestServices at module scope",
      should: 'report no problems',
      actual: codes(guarded),
      expected: [],
    });
  });

  test('accepts the guard under a local alias', () => {
    assert({
      given: 'an aliased import of requireTestServices, called at load',
      should: 'report no problems',
      actual: codes(
        [
          "import { requireTestServices as services } from '@offense-demo/config';",
          'const urls = services(process.env);',
        ].join('\n'),
      ),
      expected: [],
    });
  });

  test('flags a hand-written guard that only mentions the variables', () => {
    assert({
      given: 'a copied text guard that reads TEST_DATABASE_URL and throws',
      should: 'fail with GUARD_MISSING: the shared import is the contract',
      actual: codes(
        [
          'const url = process.env.TEST_DATABASE_URL;',
          "if (!url) throw new Error('TEST_DATABASE_URL required');",
        ].join('\n'),
      ),
      expected: ['GUARD_MISSING'],
    });
  });

  test('flags a guard named only in a comment or a string', () => {
    assert({
      given: 'text that names requireTestServices without importing it',
      should: 'fail with GUARD_MISSING',
      actual: codes(
        [
          "// import { requireTestServices } from '@offense-demo/config';",
          "const note = 'requireTestServices(process.env)';",
        ].join('\n'),
      ),
      expected: ['GUARD_MISSING'],
    });
  });

  test('flags an imported guard that is never called at load', () => {
    assert({
      given: 'the import alone, and a call deferred into a test body',
      should:
        'fail both with GUARD_MISSING: nothing throws when the file loads',
      actual: [
        codes("import { requireTestServices } from '@offense-demo/config';"),
        codes(
          [
            "import { requireTestServices } from '@offense-demo/config';",
            "test('x', () => { requireTestServices(process.env); });",
          ].join('\n'),
        ),
      ],
      expected: [['GUARD_MISSING'], ['GUARD_MISSING']],
    });
  });

  test('accepts the guard as a top-level declaration or statement only', () => {
    assert({
      given:
        'the guard as a top-level expression statement and as a const initializer',
      should: 'report no problems for either',
      actual: [
        codes(
          [
            "import { requireTestServices } from '@offense-demo/config';",
            'requireTestServices(process.env);',
          ].join('\n'),
        ),
        codes(guarded),
      ],
      expected: [[], []],
    });
  });

  test('flags a guard call that may never run or checks something else', () => {
    const probe = (call: string) =>
      codes(
        [
          "import { requireTestServices } from '@offense-demo/config';",
          call,
        ].join('\n'),
      );
    assert({
      given:
        'a guard behind an if, a swallowed try, a short-circuit, an optional call, literal values, and a nested block',
      should: 'fail every one with GUARD_MISSING: none must throw at load',
      actual: [
        probe('if (process.env.CI) requireTestServices(process.env);'),
        probe('try { requireTestServices(process.env); } catch {}'),
        probe('process.env.SKIP || requireTestServices(process.env);'),
        probe('requireTestServices?.(process.env);'),
        probe(
          "requireTestServices({ TEST_DATABASE_URL: 'postgres://x/y_test', TEST_REDIS_URL: 'redis://x' });",
        ),
        probe('{ requireTestServices(process.env); }'),
        probe(
          'const services = hasServices && requireTestServices(process.env);',
        ),
      ],
      expected: Array.from({ length: 7 }, () => ['GUARD_MISSING']),
    });
  });

  test('flags a same-named guard from another module', () => {
    assert({
      given: 'requireTestServices imported from a local helper',
      should: 'fail with GUARD_MISSING: only the shared guard counts',
      actual: codes(
        [
          "import { requireTestServices } from './helpers';",
          'requireTestServices(process.env);',
        ].join('\n'),
      ),
      expected: ['GUARD_MISSING'],
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  expectedOf,
  outcomes,
  repositoryEslint,
  table,
  web,
  serverBindCases,
  serverGlobCases,
  sharedFixtureCases,
  type Problems,
  props,
  globals,
  imports,
  edgeImport,
  reads,
  mutations,
  sixMutations,
  route,
  lazyEdge,
  e2eServer,
  escapes,
  escapeRule,
} from './eslint.config.test-support';

setupRitewayBun();

describe('repository ESLint configuration', () => {
  test('rejects ambient time and identity reads outside the allowlist', async () => {
    const eslint = repositoryEslint();
    const [result] = await eslint.lintText(
      'Date.now(); new Date(); Math.random(); crypto.randomUUID();',
      { filePath: 'packages/protocol/src/ambient.ts' },
    );

    assert({
      given: 'unallowlisted source using ambient time or identity primitives',
      should:
        'report one lint error for each forbidden primitive, plus the pure-package crypto global',
      actual: result.messages.map(({ ruleId, severity }) => ({
        ruleId,
        severity,
      })),
      expected: [
        { ruleId: 'no-restricted-syntax', severity: 2 },
        { ruleId: 'no-restricted-syntax', severity: 2 },
        { ruleId: 'no-restricted-syntax', severity: 2 },
        { ruleId: 'no-restricted-globals', severity: 2 },
        { ruleId: 'no-restricted-syntax', severity: 2 },
      ],
    });
  });
});

describe('process edge: one module reads process.env and globalThis (ISSUE-7)', () => {
  test('rejects ambient reads and edge imports outside the edge', async () => {
    const cases: Case[] = [
      ['export const f = process.env.X;', web('proxy.ts'), props],
      [
        'const { env } = process;\nexport const e = env;',
        web('lib/x.ts'),
        props,
      ],
      ['export const level = Bun.env.X;', 'apps/realtime/src/server.ts', props],
      ["export const a = Reflect.get(globalThis, 'a');", route, globals],
      [
        'export const a = globalThis as unknown;',
        web('lib/identity.ts'),
        globals,
      ],
      [
        edgeImport('../../server/'),
        web('features/foundation/leak.ts'),
        imports,
      ],
      [edgeImport('../server/'), web('lib/identity.ts'), imports],
      [
        edgeImport('../server/', 'processRoute'),
        web('lib/request-routes.ts'),
        imports,
      ],
      [edgeImport('../../../../server/'), route, imports],
      [edgeImport('./'), web('server/routes.ts'), imports],
      ...escapes.map(([code, file]): Case => [code, file, escapeRule(code)]),
    ];
    assert({
      given:
        'app source reading process.env, Bun.env or globalThis, or importing the process edge as a locator',
      should: 'report each as the matching restriction',
      actual: await outcomes(cases),
      expected: expectedOf(cases),
    });
  });

  test('admits the edges, route bindings and the documented process entries', async () => {
    const cases: Case[] = [
      [reads, web('server/process-app.ts'), []],
      [reads, 'apps/realtime/src/start.ts', []],
      [edgeImport('../../../../server/', 'processRoute'), route, []],
      [edgeImport('./server/'), web('proxy.ts'), []],
      [edgeImport('./server/'), web('instrumentation.ts'), []],
      [edgeImport('./'), web('server/start.ts'), []],
      [edgeImport('../server/'), web('lib/request-session.ts'), []],
      [
        edgeImport('../server/', 'processRoute'),
        web('lib/request-route.ts'),
        [],
      ],
      [lazyEdge('./server/process-app'), web('instrumentation.ts'), []],
      [edgeImport('../../src/server/', 'adoptProcessApp'), e2eServer, []],
      [
        'export const u = process.env.TEST_DATABASE_URL;',
        'apps/web/integration/r.integration.ts',
        [],
      ],
    ];
    assert({
      given:
        'the two edges, a processRoute binding, the process entries and a test reading its service URL',
      should: 'report nothing',
      actual: await outcomes(cases),
      expected: expectedOf(cases),
    });
  });

  test('rejects mutating process.env or globalThis in app tests', async () => {
    const cases: Case[] = [
      [mutations, 'apps/web/integration/leaky.integration.ts', sixMutations],
      [mutations, web('server/leaky.test.ts'), sixMutations],
      [mutations, 'apps/realtime/src/leaky.test.ts', sixMutations],
    ];
    assert({
      given:
        'an integration suite and two unit tests mutating process.env and globalThis six ways',
      should: 'report every mutation as no-restricted-syntax',
      actual: await outcomes(cases),
      expected: expectedOf(cases),
    });
  });
});

describe('restrictions every no-restricted-syntax list carries', () => {
  test('rejects `export *` everywhere, the ambient-time exemption included (RT-2.1c AC2, AC6)', async () => {
    const { actual, expected } = table([
      ["export * from './realtime';", 'packages/protocol/src/index.ts', 1],
      ["export * from './index';", 'packages/clock/src/index.ts', 1],
      ["export { parseTopic } from './realtime';", web('x.ts'), 0],
    ]);
    assert({
      given:
        'a wildcard export in a source file and in packages/clock (whose exemption turns off the rest of no-restricted-syntax), and a named re-export',
      should:
        'report each wildcard export as an error and the named form not at all',
      actual: await actual,
      expected,
    });
  });

  test('rejects an unbound Bun.serve under every glob, beside the Redis guard in every integration workspace (ISSUE-252, ISSUE-259)', async () => {
    const { actual, expected } = table(serverGlobCases);
    assert({
      given:
        'an unbound Bun.serve and a raw RedisClient in each integration workspace, an unbound Bun.serve under every other glob, and a bound one',
      should:
        'report the serve everywhere and the Redis client in every integration workspace, and the bound serve nowhere',
      actual: await actual,
      expected,
    });
  });

  test('rejects every route to a wildcard-bound server and leaves bound or unrelated calls alone (ISSUE-254, ISSUE-278)', async () => {
    const { actual, expected } = table(
      serverBindCases.map(([code, flagged]): Problems => [
        code,
        'scripts/x.test.ts',
        flagged ? 1 : 0,
      ]),
    );
    assert({
      given:
        'Bun.serve and Bun.listen, destructured, imported, aliased and globalThis forms, every wildcard spelling, node listen calls, and a Postgres LISTEN',
      should: 'report each wildcard or unaddressed bind once and nothing else',
      actual: await actual,
      expected,
    });
  });

  test('requires every e2e spec and page to go through the shared, bounded fixture (ISSUE-253, ISSUE-276, ISSUE-277)', async () => {
    const { actual, expected } = table(sharedFixtureCases);
    assert({
      given:
        'specs importing Playwright’s test by name, namespace, default, re-export or dynamic import, or calling newPage directly; the shared fixture; only types and expect; openPage',
      should:
        'reject every route to Playwright’s own test or newPage outside the shared fixture, and nothing else',
      actual: await actual,
      expected,
    });
  });

  test('rejects an argument-less toThrow in every kind of suite (ISSUE-11)', async () => {
    const [bare, named] = [
      ['', ''],
      ["'refused'", 'TypeError'],
    ].map(
      ([message, type]) =>
        `import { expect } from 'bun:test';\nawait expect(async () => {}).rejects.toThrow(${message});\nexpect(() => {}).toThrowError(${type});\nexpect(() => {}).not.toThrow();`,
    ) as [string, string];
    const suites = [
      web('server/x.test.ts'),
      'packages/db/integration/x.integration.ts',
      'apps/web/integration/x.integration.ts',
      'apps/web/e2e/x.e2e.ts',
      'scripts/x.test.ts',
    ];
    const { actual, expected } = table([
      ...suites.map((suite): Problems => [bare, suite, 2]),
      [named, web('server/x.test.ts'), 0],
    ]);
    assert({
      given:
        'unit, integration, e2e and script suites asserting a bare toThrow, one naming the error, and a strict not.toThrow()',
      should:
        'report each bare toThrow as an error and the named and negated ones not at all',
      actual: await actual,
      expected,
    });
  });
});

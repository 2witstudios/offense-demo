import { ESLint } from 'eslint';

// One instance for the whole file: building the typed-lint program is the
// expensive step, and under machine load it dominated every test. The lint
// scripts pass a load-tolerant --timeout instead of Bun's fixed 5 s.
let shared: ESLint | undefined;
export const repositoryEslint = (): ESLint =>
  (shared ??= new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: './eslint.config.mjs',
  }));

/** Each problem ESLint reports for `code` at `filePath`, with its severity. */
const problems = async (code: string, filePath: string) => {
  const [result] = await repositoryEslint().lintText(code, { filePath });
  return (result?.messages ?? []).map(({ ruleId, severity }) => ({
    ruleId,
    severity,
  }));
};
/** The rule id of each problem ESLint reports for `code` at `filePath`. */
const ruleIds = async (code: string, filePath: string) =>
  (await problems(code, filePath)).map(({ ruleId }) => ruleId);
export type Problems = readonly [
  code: string,
  filePath: string,
  errors: number,
];
export const table = (cases: readonly Problems[]) => ({
  actual: Promise.all(cases.map(([code, path]) => problems(code, path))),
  expected: cases.map(([, , errors]) =>
    Array(errors).fill({ ruleId: 'no-restricted-syntax', severity: 2 }),
  ),
});

export type Case = readonly [code: string, filePath: string, ruleIds: string[]];
export const outcomes = (cases: readonly Case[]) =>
  Promise.all(cases.map(([code, filePath]) => ruleIds(code, filePath)));
export const expectedOf = (cases: readonly Case[]) =>
  cases.map(([, , ids]) => ids);

export const web = (path: string) => `apps/web/src/${path}`;

/** Fixtures for the process-edge tests (ISSUE-7). */
export const [props, globals, imports] = [
  'properties',
  'globals',
  'imports',
].map((kind) => [`no-restricted-${kind}`]);
export const edgeImport = (from: string, name = 'processApp', ext = '') =>
  `import { ${name} } from '${from}process-app${ext}';\nexport const x = ${name};`;
export const reads =
  'export const env = process.env;\nexport const g = globalThis as unknown;';
export const mutations = [
  "process.env.FOUNDATION_PROOF_ENABLED = 'true';",
  'delete process.env.DATABASE_URL;',
  "Object.assign(process.env, { NODE_ENV: 'test' });",
  'globalThis.fetch = (async () => new Response()) as typeof fetch;',
  "Reflect.set(globalThis, 'offenseDemoResources', {});",
  "Reflect.deleteProperty(process.env, 'PUBLIC_APP_URL');",
].join('\n');
export const sixMutations = Array.from(
  { length: 6 },
  () => 'no-restricted-syntax',
);
export const route = web('app/api/health/ready/route.ts');
export const lazyEdge = (path: string) =>
  `export const l = () => import('${path}');`;
const suite = 'apps/web/integration/leak.integration.ts';
export const e2eServer = 'apps/web/e2e/support/server.ts';
/** Every spelling that reaches the edge outside its entries (review 2). */
const computed = "export const l = import(`./${'process-app'}`);";
export const escapes: ReadonlyArray<readonly [string, string]> = [
  [edgeImport('../../server/', 'processApp', '.js'), web('features/x.ts')],
  [edgeImport('/repo/apps/web/src/server/', 'processApp', '.ts'), web('x.ts')],
  [lazyEdge('../../server/process-app'), web('features/x.ts')],
  [lazyEdge('../../server/process-app.js'), route],
  [computed, web('server/x.ts')],
  [edgeImport('../src/server/'), suite],
  [lazyEdge('../src/server/process-app'), suite],
  [edgeImport('../../src/server/'), 'apps/web/e2e/journey.e2e.ts'],
];
export const escapeRule = (code: string) =>
  code.startsWith('import {') ? imports : ['no-restricted-syntax'];

/**
 * Every route to a server bound to the wildcard address that the lint gate
 * must reject, and the bound or unrelated calls it must leave alone
 * (ISSUE-252, ISSUE-254). Each flagged case reports exactly one problem.
 */
export const serverBindCases: ReadonlyArray<readonly [string, boolean]> = [
  ["Bun.serve({ port: 0, fetch: () => ({ hostname: 'x' }) });", true],
  ["Bun.serve({ hostname: '127.0.0.1', port: 0 });", false],
  ["const hostname = '127.0.0.1';\nBun.serve({ hostname, port: 0 });", false],
  ["Bun.serve({ hostname: '0.0.0.0', port: 0 });", true],
  ["Bun.serve({ hostname: '::', port: 0 });", true],
  ['globalThis.Bun.serve({ port: 0 });', true],
  ['const { serve } = Bun;\nserve({ port: 0 });', true],
  ['const { listen } = globalThis.Bun;\nexport const l = listen;', true],
  ['Bun.listen({ port: 0, socket: {} });', true],
  ["Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {} });", false],
  [
    'declare const server: { listen: (...a: unknown[]) => void };\nserver.listen(0);',
    true,
  ],
  [
    'declare const server: { listen: (...a: unknown[]) => void };\nserver.listen(0, () => {});',
    true,
  ],
  [
    "declare const server: { listen: (...a: unknown[]) => void };\nserver.listen(0, '127.0.0.1', () => {});",
    false,
  ],
  [
    "declare const server: { listen: (...a: unknown[]) => void };\nserver.listen(0, '0.0.0.0');",
    true,
  ],
  [
    'declare const server: { listen: (...a: unknown[]) => void };\nserver.listen({ port: 0 });',
    true,
  ],
  [
    "declare const server: { listen: (...a: unknown[]) => void };\nserver.listen({ port: 0, host: '127.0.0.1' });",
    false,
  ],
  [
    "declare const server: { listen: (...a: unknown[]) => void };\nserver.listen({ port: 0, host: '::' });",
    true,
  ],
  [
    "declare const client: { listen: (...a: unknown[]) => void };\nclient.listen('outbox', () => {});",
    false,
  ],
  // ISSUE-278: the routes the ISSUE-254 selectors still missed.
  ["import { serve } from 'bun';\nserve({ port: 0 });", true],
  ["import { listen as l } from 'bun';\nl({ port: 0, socket: {} });", true],
  ['const b = Bun;\nb.serve({ port: 0 });', true],
  ['const b = globalThis.Bun;\nb.serve({ port: 0 });', true],
  ["import { SQL } from 'bun';\nexport const s = SQL;", false],
  ['Bun.serve({ hostname: undefined, port: 0 });', true],
  ["Bun.serve({ hostname: '', port: 0 });", true],
  ["Bun.serve({ hostname: '::0', port: 0 });", true],
  ["Bun.serve({ hostname: '[::]', port: 0 });", true],
  ["Bun.serve({ hostname: 'localhost', port: 0 });", false],
  [
    "declare const server: { listen: (...a: unknown[]) => void };\nserver.listen({ port: 0, host: '[::]' });",
    true,
  ],
  // ISSUE-283: Bun reached through a namespace or default import of 'bun',
  // and the remaining spellings of the wildcard address; loopback stays clean.
  ["import * as b from 'bun';\nb.serve({ port: 0 });", true],
  ["import b from 'bun';\nb.serve({ port: 0 });", true],
  ["Bun.serve({ hostname: '0', port: 0 });", true],
  ["Bun.serve({ hostname: '::0000', port: 0 });", true],
  ["Bun.serve({ hostname: '0:0:0:0:0:0:0:0', port: 0 });", true],
  ["Bun.serve({ hostname: '::1', port: 0 });", false],
  ["Bun.serve({ hostname: '10.0.0.1', port: 0 });", false],
  // ISSUE-286: the default export by name, a dynamic import, and the
  // IPv4-mapped wildcard; a mapped loopback stays clean.
  ["import { default as b } from 'bun';\nb.serve({ port: 0 });", true],
  ["const b = await import('bun');\nb.serve({ port: 0 });", true],
  ["const { serve } = await import('bun');\nserve({ port: 0 });", true],
  ["(await import('bun')).serve({ port: 0 });", true],
  ["import('bun').then((b) => b.serve({ port: 0 }));", true],
  ["const { SQL } = await import('bun');\nexport const s = SQL;", false],
  ["Bun.serve({ hostname: '::ffff:0.0.0.0', port: 0 });", true],
  ["Bun.serve({ hostname: '::FFFF:0.0.0.0', port: 0 });", true],
  ["Bun.serve({ hostname: '::ffff:127.0.0.1', port: 0 });", false],
];

const unboundServe = `const url = 'redis://x';\nnew RedisClient(url);\nBun.serve({ port: 0, fetch: () => new Response(url) });`;
const boundServe = `const hostname = '127.0.0.1';\nBun.serve({ hostname, port: 0, fetch: () => new Response(hostname) });`;
/**
 * An unbound Bun.serve beside a raw RedisClient in each integration
 * workspace (two problems: both lists must survive every override), the
 * serve alone under every other glob the rule covers (one), and a bound
 * serve (none) (ISSUE-252, ISSUE-259).
 */
export const serverGlobCases: readonly Problems[] = [
  ...['packages/db', 'packages/redis', 'apps/realtime', 'apps/web'].map(
    (root): Problems => [
      unboundServe,
      `${root}/integration/x.integration.ts`,
      2,
    ],
  ),
  ...[
    'scripts/x.test.ts',
    'apps/web/e2e/x.e2e.ts',
    web('x.ts'),
    'packages/clock/src/x.ts',
    'packages/db/src/x.ts',
    'apps/realtime/src/x.ts',
  ].map((path): Problems => [
    unboundServe.replace('new RedisClient(url);\n', ''),
    path,
    1,
  ]),
  [boundServe, 'packages/db/integration/x.integration.ts', 0],
];

/**
 * Every spec runs on the shared fixture (ISSUE-253): Playwright's own `test`
 * has an unbounded page fixture, so a spec importing it is an error, while
 * the shared fixture and type-only imports are fine.
 */
const importCases: readonly Problems[] = [
  [
    "import { expect, test } from '@playwright/test';\ntest('x', () => expect(1).toBe(1));",
    'apps/web/e2e/x.e2e.ts',
    1,
  ],
  [
    "import { test as t } from '@playwright/test';\nt('x', () => {});",
    'apps/web/e2e/x.e2e.ts',
    1,
  ],
  [
    "import { expect, test } from './support/fixtures';\ntest('x', () => expect(1).toBe(1));",
    'apps/web/e2e/x.e2e.ts',
    0,
  ],
  [
    "import type { Page } from '@playwright/test';\nexport const p = (page: Page) => page;",
    'apps/web/e2e/x.e2e.ts',
    0,
  ],
  // ISSUE-276: every other way to reach Playwright's own test.
  [
    "import * as pw from '@playwright/test';\npw.test('x', () => {});",
    'apps/web/e2e/x.e2e.ts',
    1,
  ],
  [
    "import pw from '@playwright/test';\npw.test('x', () => {});",
    'apps/web/e2e/x.e2e.ts',
    1,
  ],
  ["export { test } from '@playwright/test';", 'apps/web/e2e/support/x.ts', 1],
  [
    "export { test as t } from '@playwright/test';",
    'apps/web/e2e/support/x.ts',
    1,
  ],
  [
    "export const load = () => import('@playwright/test');",
    'apps/web/e2e/x.e2e.ts',
    1,
  ],
  [
    "import { expect, type Page } from '@playwright/test';\nexport const p = (page: Page) => expect(page);",
    'apps/web/e2e/x.e2e.ts',
    0,
  ],
  [
    "import type * as pw from '@playwright/test';\nexport type P = pw.Page;",
    'apps/web/e2e/x.e2e.ts',
    0,
  ],
  // The shared fixture itself is the one module built on Playwright's test.
  [
    "import * as playwright from '@playwright/test';\nexport const test = playwright.test.extend({});",
    'apps/web/e2e/support/fixtures.ts',
    0,
  ],
];

const secondaryPage = (call: string) =>
  `import type { Browser, BrowserContext } from '@playwright/test';\ndeclare const browser: Browser;\ndeclare const context: BrowserContext;\nexport const handles = [browser, context];\nexport const p = ${call};`;
/**
 * Every page a spec opens goes through the shared, bounded openPage
 * (ISSUE-277): a direct newPage on a context or a browser is an error
 * everywhere but the shared fixture.
 */
const secondaryPageCases: readonly Problems[] = [
  [secondaryPage('context.newPage()'), 'apps/web/e2e/x.e2e.ts', 1],
  [secondaryPage('browser.newPage()'), 'apps/web/e2e/x.e2e.ts', 1],
  [secondaryPage('context.newPage'), 'apps/web/e2e/support/x.ts', 1],
  // ISSUE-283: a computed member reaches the same method.
  [secondaryPage("context['newPage']()"), 'apps/web/e2e/x.e2e.ts', 1],
  [secondaryPage('context[`newPage`]()'), 'apps/web/e2e/x.e2e.ts', 1],
  [
    secondaryPage("openPage(context, 'the other device')").replace(
      'export const p',
      "import { openPage } from './support/fixtures';\nexport const p",
    ),
    'apps/web/e2e/x.e2e.ts',
    0,
  ],
  [secondaryPage('context.newPage()'), 'apps/web/e2e/support/fixtures.ts', 0],
];

export const sharedFixtureCases: readonly Problems[] = [
  ...importCases,
  ...secondaryPageCases,
];

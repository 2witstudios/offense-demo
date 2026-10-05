import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import betterTailwind from 'eslint-plugin-better-tailwindcss';
import { getDefaultSelectors } from 'eslint-plugin-better-tailwindcss/defaults';

/**
 * Shared between the repo-wide `no-restricted-syntax` entry and the
 * ambient-time exemption below, so the two copies can't drift: AGENTS.md's
 * explicit-exports rule applies to every workspace source file, with no
 * exception.
 */
const exportStarRestriction = {
  selector: 'ExportAllDeclaration',
  message:
    'Use named re-exports, not `export *` (AGENTS.md: explicit exports, no barrels).',
};

/**
 * ISSUE-11: an expected failure names what it expects. A bare `.toThrow()`
 * passes for any error, including a typo's TypeError; name the message,
 * pattern or class, or use `assertRejects` from `@offense-demo/errors/testing`.
 * `.not.toThrow()` stays: with no argument it is the strict form.
 * Every `no-restricted-syntax` list below carries it, as it does the
 * export-star ban.
 */
const bareToThrowRestriction = {
  selector:
    'CallExpression[callee.property.name=/^toThrow(Error)?$/][arguments.length=0]:not([callee.object.property.name="not"])',
  message:
    'Name the expected error (message, pattern or class) or use assertRejects from @offense-demo/errors/testing.',
};

/**
 * ISSUE-252: a Bun.serve with no hostname binds the wildcard address, and on
 * macOS another process may hold the same port on 127.0.0.1; requests to
 * 127.0.0.1 then reach that process instead (an Ollama or GitHub listener
 * answered a probe test's request). Binding 127.0.0.1 explicitly makes the
 * kernel refuse or avoid the taken port. Carried by every list, like the
 * two above.
 */
const bunCallee =
  ":matches([callee.object.name='Bun'], [callee.object.object.name='globalThis'][callee.object.property.name='Bun'])";
// Every spelling of the wildcard address: IPv4's all-zero forms ('0',
// '0.0.0.0'), IPv6's (only zeros and colons, bracketed or not: '::', '::0',
// '::0000', '0:0:0:0:0:0:0:0', '[::]'), the IPv4-mapped '::ffff:0.0.0.0',
// and the empty string (ISSUE-278, ISSUE-283, ISSUE-286). Loopback ('::1',
// '127.0.0.1', '::ffff:127.0.0.1') has a non-zero digit.
const wildcardAddress =
  '/^(0+(\\.0+){0,3}|\\[?[0:]*:[0:]*\\]?|\\[?[0:]*:[fF]{4}:0+(\\.0+){3}\\]?|)$/';
const bindMessage =
  "Bind the server's address (hostname or host: '127.0.0.1'): a wildcard bind can share its port with another process's loopback listener.";
/**
 * ISSUE-254 closes the routes the first selector missed: a hostname nested
 * in the handler rather than the options, an explicit wildcard address,
 * globalThis.Bun, a destructured serve or listen, Bun.listen, and a node
 * server's listen() with no host. ISSUE-278, ISSUE-283 and ISSUE-286 add
 * serve or listen imported from 'bun', Bun under another name (an alias,
 * or 'bun' imported whole, by default name or dynamically), hostname:
 * undefined and every wildcard spelling. Production's listen(port, host, …)
 * and a Postgres LISTEN (a string channel) stay clean.
 */
const unboundServerRestrictions = [
  `CallExpression[callee.property.name=/^(serve|listen)$/]${bunCallee} > ObjectExpression.arguments:not(:has(> Property[key.name='hostname']))`,
  `CallExpression[callee.property.name=/^(serve|listen)$/]${bunCallee} > ObjectExpression.arguments > Property[key.name='hostname'][value.value=${wildcardAddress}]`,
  // The Identifier type matters: esquery reads a Literal's missing name as
  // the string 'undefined', which would match every hostname.
  `CallExpression[callee.property.name=/^(serve|listen)$/]${bunCallee} > ObjectExpression.arguments > Property[key.name='hostname'] > Identifier.value[name='undefined']`,
  // ISSUE-278: serve and listen imported from 'bun', and Bun under another
  // name, reach the same servers without the Bun callee the selectors see.
  "ImportDeclaration[source.value='bun'] > ImportSpecifier[imported.name=/^(serve|listen)$/]",
  "VariableDeclarator[id.type='Identifier']:matches([init.name='Bun'], [init.object.name='globalThis'][init.property.name='Bun'])",
  // ISSUE-283, ISSUE-286: 'bun' imported whole (namespace, default, the
  // default by name, or dynamically) is Bun under another name.
  "ImportDeclaration[source.value='bun'] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)",
  "ImportDeclaration[source.value='bun'] > ImportSpecifier[imported.name='default']",
  // A dynamic import stays clean when it takes named values (SQL), and is
  // rejected when it can reach a server: the module bound whole, serve or
  // listen destructured, called on the awaited module, or handed to then().
  "VariableDeclarator[id.type='Identifier'] > AwaitExpression.init > ImportExpression[source.value='bun']",
  "VariableDeclarator[init.type='AwaitExpression'][init.argument.type='ImportExpression'][init.argument.source.value='bun'] > ObjectPattern.id > Property[key.name=/^(serve|listen)$/]",
  "MemberExpression[property.name=/^(serve|listen)$/] > AwaitExpression.object > ImportExpression[source.value='bun']",
  "CallExpression[callee.property.name='then'] > MemberExpression.callee > ImportExpression.object[source.value='bun']",
  "VariableDeclarator:matches([init.name='Bun'], [init.object.name='globalThis'][init.property.name='Bun']) > ObjectPattern > Property[key.name=/^(serve|listen)$/]",
  `CallExpression[callee.property.name='listen']:not(${bunCallee}):not([arguments.0.type='Literal'][arguments.0.value=/^[^0-9]/]):not([arguments.0.type='TemplateLiteral']):matches([arguments.length=1][arguments.0.type!='ObjectExpression'], [arguments.1.type=/Function/])`,
  `CallExpression[callee.property.name='listen']:not(${bunCallee}) > ObjectExpression.arguments:not(:has(> Property[key.name='host']))`,
  `CallExpression[callee.property.name='listen']:not(${bunCallee}) > Literal.arguments[value=${wildcardAddress}]`,
  `CallExpression[callee.property.name='listen']:not(${bunCallee}) > ObjectExpression.arguments > Property[key.name='host'][value.value=${wildcardAddress}]`,
].map((selector) => ({ selector, message: bindMessage }));

/**
 * ISSUE-245: an integration file reaches Redis only through the guarded
 * helper (`openTestRedis`, whose URL came from `requireTestServices`, which
 * refuses any database or server that is not the slot's own) and never
 * deletes database-wide, so running any one file directly can never touch
 * another slot's, dev's or e2e's keys.
 */
const testRedisRestrictions = [
  {
    selector: "NewExpression[callee.name='RedisClient']",
    message:
      "Open Redis with openTestRedis(url) from @offense-demo/redis/testing: it takes only a URL requireTestServices guarded as the slot's own database.",
  },
  {
    selector: "NewExpression[callee.property.name='RedisClient']",
    message:
      'Open Redis with openTestRedis(url) from @offense-demo/redis/testing, not a namespaced RedisClient.',
  },
  {
    selector:
      "MemberExpression[object.name='Bun'][property.name=/^(?:redis|RedisClient)$/], MemberExpression[object.name='Bun'][computed=true][property.value=/^(?:redis|RedisClient)$/], MemberExpression[object.property.name='Bun'][property.name=/^(?:redis|RedisClient)$/]",
    message:
      'Bun.redis and Bun.RedisClient dial Redis without requireTestServices: open Redis with openTestRedis(url).',
  },
  {
    selector:
      "VariableDeclarator[init.name='Bun'] > ObjectPattern > Property[key.name=/^(?:redis|RedisClient)$/], VariableDeclarator[init.property.name='Bun'] > ObjectPattern > Property[key.name=/^(?:redis|RedisClient)$/]",
    message:
      'Do not pull redis or RedisClient out of Bun: open Redis with openTestRedis(url).',
  },
  {
    selector:
      "VariableDeclarator[id.type='Identifier'][init.name='Bun'], VariableDeclarator[id.type='Identifier'][init.property.name='Bun'], VariableDeclarator[id.type='Identifier'][init.computed=true][init.property.value='Bun'], ObjectPattern > Property[key.name='Bun']",
    message:
      'Do not alias the Bun global: a suite reaches Redis only through openTestRedis(url).',
  },
  {
    selector:
      "ImportExpression[source.value='bun'], CallExpression[callee.name='require'][arguments.0.value='bun']",
    message:
      "Import 'bun' statically (only SQL and the like): a dynamic import or require reaches RedisClient and redis.",
  },
  {
    selector:
      "MemberExpression[property.name='constructor'], MemberExpression[computed=true][property.value='constructor']",
    message:
      'Never reach a constructor from a value in a suite: openTestRedis returns a wrapper with none, and a raw client is not for tests.',
  },
  {
    selector:
      "CallExpression[callee.name='deleteKeysWithoutExpiry'][arguments.length<2], CallExpression[callee.name='deleteKeysWithoutExpiry'][arguments.1.value='*']",
    message:
      'Never scan the whole database in a suite: pass deleteKeysWithoutExpiry a pattern under your own namespace.',
  },
  {
    selector: "ImportSpecifier[imported.name='deleteAllKeysWithoutExpiry']",
    message:
      "deleteAllKeysWithoutExpiry walks the whole database and is the runner's alone.",
  },
  {
    selector: 'Literal[value=/^(?:FLUSHDB|FLUSHALL)$/i]',
    message: 'Never FLUSHDB or FLUSHALL: delete exactly your own namespace.',
  },
  {
    selector:
      "CallExpression[callee.property.name='send'][arguments.0.value=/^scan$/i]:has(ArrayExpression > Literal[value='*'])",
    message:
      'Never SCAN the whole database in a suite: match your own namespace.',
  },
  {
    selector:
      "CallExpression[callee.property.name='send'][arguments.0.value=/^keys$/i]:has(ArrayExpression > Literal[value='*'])",
    message:
      'Never list every key of the database in a suite: match your own namespace.',
  },
  {
    selector:
      "CallExpression[callee.property.name='keys'][arguments.0.value='*']",
    message:
      'Never list every key of the database in a suite: match your own namespace.',
  },
  {
    selector:
      "CallExpression[callee.property.name='send'][arguments.length=2][arguments.1.type='ArrayExpression']:not([arguments.0.type='Literal'])",
    message:
      'Name the Redis command as a string literal so it can be checked; a template, join or variable can hide FLUSHDB or a whole-database scan.',
  },
];

/** `bun`'s Redis exports in an integration file: only a type-only import of RedisClient is fine. */
const bunRedisImport = {
  name: 'bun',
  importNames: ['RedisClient', 'redis'],
  allowTypeImports: true,
  message:
    "Open Redis with openTestRedis(url) from @offense-demo/redis/testing; the default 'redis' export dials REDIS_URL and skips requireTestServices.",
};

/**
 * ISSUE-7's process edge: app code receives configuration and resources as
 * arguments from a composition root, so nothing in an app may mutate
 * process.env or globalThis, tests included (each builds its own app).
 * Shared by the repo-wide `no-restricted-syntax` entry and the apps'
 * integration override below, which replaces that entry's options.
 */
const processMutationRestrictions = [
  {
    selector:
      "AssignmentExpression > MemberExpression.left[object.object.name='process'][object.property.name='env']",
    message: 'Never write process.env; build an app with its own env.',
  },
  {
    selector:
      "AssignmentExpression > MemberExpression.left[object.name='globalThis']",
    message: 'Never write globalThis; inject the value instead.',
  },
  {
    selector:
      "UnaryExpression[operator='delete'] > MemberExpression[object.object.name='process'][object.property.name='env']",
    message: 'Never delete from process.env; build an app with its own env.',
  },
  {
    selector:
      "UnaryExpression[operator='delete'] > MemberExpression[object.name='globalThis']",
    message: 'Never delete from globalThis; inject the value instead.',
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(Object|Reflect)$/][callee.property.name=/^(assign|set|deleteProperty|defineProperty)$/][arguments.0.object.name='process'][arguments.0.property.name='env']",
    message: 'Never write process.env; build an app with its own env.',
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(Object|Reflect)$/][callee.property.name=/^(assign|set|deleteProperty|defineProperty)$/][arguments.0.name='globalThis']",
    message: 'Never write globalThis; inject the value instead.',
  },
];

/** Every app module's import boundary (the process-edge entries below add to it). */
const appImportRestrictions = [{ group: ['@offense-demo/*/src/*'] }];

/**
 * ISSUE-7: the web process edge (`server/process-app.ts`) holds the
 * process's app, so importing it is reaching a process-wide locator. Route
 * modules and server action modules (`actions.ts`) may bind `processRoute`
 * only; the process entries (proxy,
 * instrumentation, production start, and the server-component session
 * read) may use `processApp`; everything else receives the app, or part of
 * it, as an argument.
 */
const processEdgeMessage =
  'Receive the app as an argument; only route bindings and the process entries import the process edge.';
/** Any specifier naming the edge module, relative or absolute, any extension. */
const processEdgePath = '(^|/)process-app(\\.[cm]?[jt]sx?)?$';
const processEdgeImport = {
  regex: processEdgePath,
  message: processEdgeMessage,
};
/** The same edge reached through `import()`; a computed specifier hides it. */
const processEdgeLoads = [
  {
    selector: `ImportExpression[source.value=/${processEdgePath.replaceAll('/', '\\/')}/]`,
    message: processEdgeMessage,
  },
  {
    selector: "ImportExpression[source.type!='Literal']",
    message:
      'Use a literal import() specifier so the import boundaries can check it.',
  },
];
const processEntries = [
  'apps/web/src/proxy.ts',
  'apps/web/src/instrumentation.ts',
  'apps/web/src/server/start.ts',
  'apps/web/src/lib/request-session.ts',
];

/**
 * ISSUE-9: the domain and contract packages are pure, so they read no host
 * clock, randomness, environment, timer or runtime at all; the app edges
 * inject each one. The repo-wide list above still applies on top.
 */
const pureAmbientGlobals = [
  ['performance', 'Inject a clock instead of reading the host timer.'],
  ['crypto', 'Inject an identity or randomness source.'],
  ['process', 'Receive configuration as an argument.'],
  ['Bun', 'Domain and contract packages are runtime-independent.'],
  ['globalThis', 'Receive resources as arguments.'],
  ...[
    'setTimeout',
    'setInterval',
    'setImmediate',
    'clearTimeout',
    'clearInterval',
    'clearImmediate',
    'queueMicrotask',
  ].map((name) => [name, 'Inject a scheduler instead of a host timer.']),
].map(([name, message]) => ({ name, message }));
const purePackages = [
  'packages/domain/**/*.ts',
  'packages/protocol/**/*.ts',
  'packages/errors/**/*.ts',
  'packages/auth/**/*.ts',
];

/**
 * Every spec runs on the shared fixture (apps/web/e2e/support/fixtures.ts):
 * Playwright's own page fixture and a bare newPage have no bound, while the
 * shared ones fail a stalled page creation by name and keep the evidence
 * that tells the browser, the driver and our server apart (ISSUE-253,
 * ISSUE-276, ISSUE-277, ISSUE-279).
 */
const fixtureMessage =
  'Import test from ./support/fixtures, the shared fixture with a bounded page and failure diagnostics.';
const sharedFixtureRestrictions = [
  ...[
    "ImportDeclaration[source.value='@playwright/test'] > ImportSpecifier:matches([imported.name='test'], [imported.value='test'])",
    "ImportDeclaration[source.value='@playwright/test'][importKind!='type'] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)",
    "ExportNamedDeclaration[source.value='@playwright/test'] > ExportSpecifier[local.name='test']",
    "ImportExpression[source.value='@playwright/test']",
  ].map((selector) => ({ selector, message: fixtureMessage })),
  ...[
    "MemberExpression[computed=false][property.name='newPage']",
    // ISSUE-283: c['newPage'] and c[`newPage`] reach the same method.
    "MemberExpression[computed=true][property.value='newPage']",
    "MemberExpression[computed=true] > TemplateLiteral.property[expressions.length=0] > TemplateElement[value.cooked='newPage']",
    "ObjectPattern > Property[key.name='newPage']",
  ].map((selector) => ({
    selector,
    message:
      'Open a page with openPage from ./support/fixtures: it bounds page creation and keeps the stall evidence.',
  })),
];

/** The repo-wide `no-restricted-syntax` list; overrides extend or replace it. */
const repoSyntaxRestrictions = [
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Inject a clock instead of reading the current time directly.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'Inject a clock instead of constructing the current time directly.',
  },
  {
    selector:
      "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Inject a deterministic identity or randomness source.',
  },
  {
    selector:
      "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
    message: 'Inject an identity generator instead of creating an ID directly.',
  },
  exportStarRestriction,
  bareToThrowRestriction,
  ...unboundServerRestrictions,
  ...processMutationRestrictions,
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
      '**/migrations/**',
      '.pu/**',
      '.claude/worktrees/**',
      '**/*.json',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...repoSyntaxRestrictions],
    },
  },
  // App Router only: the pages-dir heuristic cannot resolve from the repo root.
  ...nextVitals.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{ts,tsx,js,mjs}'],
    rules: { ...config.rules, '@next/next/no-html-link-for-pages': 'off' },
  })),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      complexity: ['error', 10],
      'max-lines': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  // Token-locked Tailwind (ADR 0028): classes must come from the Offense Demo theme in
  // globals.css. Arbitrary values, per-element dark variants, unknown,
  // conflicting and duplicate classes fail here; exceptions go through
  // policy/exceptions.json.
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*-class.ts'],
    plugins: { 'better-tailwindcss': betterTailwind },
    settings: {
      'better-tailwindcss': {
        entryPoint: 'apps/web/src/app/globals.css',
      },
    },
    rules: {
      'better-tailwindcss/no-unknown-classes': 'error',
      'better-tailwindcss/no-conflicting-classes': 'error',
      'better-tailwindcss/no-duplicate-classes': 'error',
      'better-tailwindcss/no-restricted-classes': [
        'error',
        {
          restrict: [
            {
              pattern: '\\[',
              message:
                'Arbitrary values and properties bypass the design tokens; add a token to the theme instead.',
            },
            {
              pattern: '(^|:)(dark|scheme-[a-z-]+):',
              message:
                'Theme colors come from light-dark() tokens; do not add per-element color-scheme variants.',
            },
            {
              pattern: '^scheme-',
              message:
                'color-scheme is owned by <html data-theme> in globals.css.',
            },
          ],
        },
      ],
    },
  },
  // Variant class modules hold nothing but class strings, under whatever
  // variable names read best (`base`, `tones`, `sizes`), so every string and
  // object value in them is checked, not only the default `className` names.
  {
    files: ['apps/web/**/*-class.ts'],
    settings: {
      'better-tailwindcss': {
        entryPoint: 'apps/web/src/app/globals.css',
        selectors: [
          ...getDefaultSelectors(),
          {
            kind: 'variable',
            name: '.*',
            match: [{ type: 'strings' }, { type: 'objectValues' }],
          },
        ],
      },
    },
  },
  {
    // The domain is pure (scripts/boundaries-rules.ts): no framework,
    // persistence, runtime or sibling workspace other than @offense-demo/errors.
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'next',
            'next/*',
            'react',
            'react/*',
            'drizzle-orm',
            'drizzle-orm/*',
            'bun',
            // RITEway's Bun-native test helper subpath, not the Bun runtime.
            '!riteway/bun',
            'node:*',
            '@offense-demo/*/src/*',
            '@offense-demo/auth',
            '@offense-demo/clock',
            '@offense-demo/config',
            '@offense-demo/db',
            '@offense-demo/logger',
            '@offense-demo/observability',
            '@offense-demo/protocol',
            '@offense-demo/realtime',
            '@offense-demo/redis',
            '@offense-demo/web',
          ],
        },
      ],
    },
  },
  {
    files: [
      'packages/protocol/**/*.ts',
      'packages/auth/**/*.ts',
      'packages/errors/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'next',
            'next/*',
            'react',
            'react/*',
            'drizzle-orm',
            'drizzle-orm/*',
            'bun',
            '!riteway/bun',
            'node:*',
            '@offense-demo/*/src/*',
            '@offense-demo/db',
            '@offense-demo/redis',
            // ISSUE-167: packages/auth is the framework-free identity domain
            // (Identity, Requirement, username shape); Better Auth is a
            // delivery-layer detail apps/web composes, never a domain import.
            'better-auth',
            'better-auth/*',
          ],
        },
      ],
    },
  },
  {
    files: purePackages,
    rules: { 'no-restricted-globals': ['error', ...pureAmbientGlobals] },
  },
  {
    files: ['packages/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'next',
            'next/*',
            'react',
            'react/*',
            '@offense-demo/*/src/*',
            '@offense-demo/web',
            '@offense-demo/domain',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: appImportRestrictions }],
    },
  },
  {
    // The AUTH-6.7 load harness (apps/web/scripts/auth-load) is procedural
    // CLI glue exactly like the root scripts/ tree, not application source.
    files: ['scripts/**/*.ts', 'apps/web/scripts/**/*.ts'],
    rules: {
      // Repo tooling is procedural CLI glue; application source remains subject
      // to the stricter complexity and size ratchets.
      complexity: ['error', 15],
      'max-lines': [
        'error',
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      'no-console': 'off',
    },
  },
  // Ambient-time/identity primitives are legitimately used here (clocks,
  // observability instrumentation, CLI scripts, integration test setup), but
  // the export-star ban applies to every workspace source file with no
  // exception: a flat-config rule array replaces the whole options list for
  // a rule id, so re-declaring `no-restricted-syntax` here with only the
  // `ExportAllDeclaration` selector turns the ambient-time restriction off
  // for these paths while keeping the export-star gate on.
  {
    files: [
      'packages/clock/**/*.ts',
      'packages/observability/**/*.ts',
      'scripts/**/*.ts',
      'apps/web/scripts/**/*.ts',
      '**/integration/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        exportStarRestriction,
        bareToThrowRestriction,
        ...unboundServerRestrictions,
      ],
    },
  },
  {
    files: ['**/integration/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [bunRedisImport] }],
    },
  },
  {
    files: ['**/integration/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        exportStarRestriction,
        bareToThrowRestriction,
        ...unboundServerRestrictions,
        ...testRedisRestrictions,
      ],
    },
  },
  // Integration setup may read ambient time, but app suites still never
  // mutate process-wide state (the exemption above replaced the list).
  {
    files: ['apps/**/integration/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        exportStarRestriction,
        bareToThrowRestriction,
        ...unboundServerRestrictions,
        ...processMutationRestrictions,
        ...testRedisRestrictions,
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/server/process-app.ts', ...processEntries],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...appImportRestrictions, processEdgeImport] },
      ],
      'no-restricted-syntax': [
        'error',
        ...repoSyntaxRestrictions,
        ...processEdgeLoads,
      ],
    },
  },
  // Tests build their own app with createApp; only the browser suite's
  // server, itself a process entry, hands the edge its app.
  {
    files: ['apps/web/integration/**/*.ts', 'apps/web/e2e/**/*.ts'],
    ignores: ['apps/web/e2e/support/server.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...appImportRestrictions, processEdgeImport] },
      ],
    },
  },
  {
    files: ['apps/web/integration/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [bunRedisImport],
          patterns: [...appImportRestrictions, processEdgeImport],
        },
      ],
      'no-restricted-syntax': [
        'error',
        exportStarRestriction,
        bareToThrowRestriction,
        ...unboundServerRestrictions,
        ...processMutationRestrictions,
        ...processEdgeLoads,
        ...testRedisRestrictions,
      ],
    },
  },
  {
    files: ['apps/web/e2e/**/*.ts'],
    ignores: ['apps/web/e2e/support/server.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...repoSyntaxRestrictions,
        ...processEdgeLoads,
        ...sharedFixtureRestrictions,
      ],
    },
  },
  // The shared fixture is the one module built on Playwright's own test and
  // newPage; every other e2e restriction still applies to it.
  {
    files: ['apps/web/e2e/support/fixtures.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...repoSyntaxRestrictions,
        ...processEdgeLoads,
      ],
    },
  },
  {
    files: ['apps/web/src/app/**/route.ts', 'apps/web/src/app/**/actions.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...appImportRestrictions,
            { ...processEdgeImport, allowImportNames: ['processRoute'] },
          ],
        },
      ],
    },
  },
  // ISSUE-7: exactly one module per app reads process.env or globalThis,
  // the process edge that builds the app (web: server/process-app.ts;
  // realtime: start.ts). Everything else receives what it needs as an
  // argument. Tests may read their test-service URLs; they may not write.
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/realtime/src/**/*.ts'],
    ignores: [
      'apps/web/src/server/process-app.ts',
      // Next inlines NEXT_RUNTIME per bundle only where it is read inline,
      // which is how the Edge bundle drops the Node-only server graph.
      'apps/web/src/instrumentation.ts',
      'apps/realtime/src/start.ts',
      '**/*.test.{ts,tsx}',
      '**/*.test-support.{ts,tsx}',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read validated config from the app; only the process edge reads process.env.',
        },
        {
          object: 'Bun',
          property: 'env',
          message:
            'Read validated config from the app; only the process edge reads the environment.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'globalThis',
          message:
            'Receive resources as arguments; only the process edge reads globalThis.',
        },
      ],
    },
  },
  {
    files: ['**/*.config.*'],
    rules: { 'no-console': 'off' },
  },
];

import { setupRitewayBun } from 'riteway/bun';

setupRitewayBun();

// The start.ts runtime-role gate (ISSUE-39): start-up runs only through
// startProductionServer (ISSUE-193), with exactly one @offense-demo/db refusal
// that nothing can duplicate, override or replace (ISSUE-206), read from the
// TypeScript AST with symbols resolved through aliases and re-exports, so
// comments and formatting never matter (ISSUE-218).
import {
  append,
  bypass,
  CALL,
  DB_IMPORT,
  edit,
  IMPORT,
  MISSING,
  NO_OP_OPTIONS,
  NOT_FROM_DB,
  ONE_CALL,
  OVERRIDDEN,
  realStart,
  REFUSAL,
  ROUTE_READ,
  type Row,
  SHIM,
  START_IMPORT,
  describeRows,
} from './runtime-role-gate.test-support';

const harmless: readonly Row[] = [
  { shape: 'the committed start.ts', startTs: realStart, expected: null },
  {
    shape: 'a JSDoc block naming startProductionServer( before the call',
    startTs: edit(
      CALL,
      `/** Starts once: startProductionServer({ ... }) is the only entry. */\n${CALL}`,
    ),
    expected: null,
  },
  {
    shape: 'a block comment naming startProductionServer( inside the call',
    startTs: edit(
      REFUSAL,
      `${REFUSAL}  /* never a second startProductionServer( call */\n`,
    ),
    expected: null,
  },
  {
    shape: 'a trailing same-line comment containing ...',
    startTs: edit(
      REFUSAL,
      "  refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web'), // no ...spread here\n",
    ),
    expected: null,
  },
  {
    shape: 'a trailing same-line comment naming refuseSchemaAlteringRole',
    startTs: edit(
      REFUSAL,
      "  refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web'), // refuseSchemaAlteringRole is @offense-demo/db's\n",
    ),
    expected: null,
  },
  {
    shape: 'a spread inside the readRouteTable body',
    startTs: edit(
      ROUTE_READ,
      "      return [...[readFileSync('/proc/net/route', 'utf8')]].join('');\n",
    ),
    expected: null,
  },
  {
    shape: 'reordered keys',
    startTs: edit(
      "  port,\n  host: '0.0.0.0',\n",
      "  host: '0.0.0.0',\n  port,\n",
    ),
    expected: null,
  },
];

const refused: readonly Row[] = [
  // ISSUE-193: start-up only through startProductionServer.
  {
    shape: "ISSUE-193 review: Next's handler handed to createProductionServer",
    startTs: append(
      'const bypass = createProductionServer({ app, handle: nextApp.getRequestHandler(), readRouteTable: () => null });\n',
    ),
    expected: bypass('createProductionServer('),
  },
  {
    shape: 'ISSUE-193: a direct nextApp.prepare()',
    startTs: append('await nextApp.prepare();\n'),
    expected: bypass('nextApp.prepare('),
  },
  {
    shape: 'ISSUE-193: a direct server.listen',
    startTs: append("server.listen(port, '0.0.0.0');\n"),
    expected: bypass('.listen('),
  },
  {
    shape: 'ISSUE-193: the refusal removed',
    startTs: edit(REFUSAL, ''),
    expected: MISSING,
  },
  {
    shape: 'ISSUE-193: the refusal commented out',
    startTs: edit(REFUSAL, `  // ${REFUSAL.trim()}\n`),
    expected: MISSING,
  },
  {
    shape: 'ISSUE-193: start-up never awaited',
    startTs: edit('await started;\n', ''),
    expected: MISSING,
  },
  // ISSUE-206: the builder's six shapes.
  {
    shape: 'ISSUE-206 review: a second call with a no-op refuseRole',
    startTs: append(
      `const again = startProductionServer(${NO_OP_OPTIONS});\nawait again.started;\n`,
    ),
    expected: ONE_CALL,
  },
  {
    shape: 'ISSUE-206 review: a spread of a no-op refuseRole',
    startTs: edit(REFUSAL, `${REFUSAL}  ...{ refuseRole: async () => {} },\n`),
    expected: OVERRIDDEN,
  },
  {
    shape: 'ISSUE-206: a spread of an options object',
    startTs: edit(REFUSAL, `${REFUSAL}  ...overrides,\n`),
    expected: OVERRIDDEN,
  },
  {
    shape: 'ISSUE-206: a second refuseRole key',
    startTs: edit(REFUSAL, `${REFUSAL}  refuseRole: async () => {},\n`),
    expected: OVERRIDDEN,
  },
  {
    shape: 'ISSUE-206: a local no-op replacing the @offense-demo/db import',
    startTs: edit(
      DB_IMPORT,
      'const refuseSchemaAlteringRole = async (..._: unknown[]) => {};\n',
    ),
    expected: NOT_FROM_DB,
  },
  {
    shape: 'ISSUE-206: the refusal imported from another module',
    startTs: edit(
      DB_IMPORT,
      "import { refuseSchemaAlteringRole } from './no-op';\n",
    ),
    files: {
      'apps/web/src/server/no-op.ts':
        'export const refuseSchemaAlteringRole = async (..._: unknown[]) => {};\n',
    },
    expected: NOT_FROM_DB,
  },
  // ISSUE-218: the review's missed shapes.
  {
    shape: 'ISSUE-218 review: an aliased import and an aliased second call',
    startTs: append(
      `import { startProductionServer as go } from './listen-first';\nconst again = go(${NO_OP_OPTIONS});\nawait again.started;\n`,
    ),
    expected: IMPORT,
  },
  {
    shape: 'ISSUE-218 review: startProductionServer.call(null, ...)',
    startTs: append(
      `const again = startProductionServer.call(null, ${NO_OP_OPTIONS});\nawait again.started;\n`,
    ),
    expected: ONE_CALL,
  },
  {
    shape: 'ISSUE-218 review: startProductionServer?.(...)',
    startTs: append(
      `const again = startProductionServer?.(${NO_OP_OPTIONS});\nawait again?.started;\n`,
    ),
    expected: ONE_CALL,
  },
  {
    shape:
      'ISSUE-218 review: a spaced second call startProductionServer ({ ... })',
    startTs: append(
      `const again = startProductionServer (${NO_OP_OPTIONS});\nawait again.started;\n`,
    ),
    expected: ONE_CALL,
  },
  {
    shape:
      'ISSUE-218 review: startProductionServer imported from a re-export shim',
    startTs: edit(
      START_IMPORT,
      "import { startProductionServer } from './shim';\n",
    ),
    files: {
      [SHIM]: "export { startProductionServer } from './listen-first';\n",
    },
    expected: IMPORT,
  },
  {
    shape:
      'ISSUE-218: a shim re-exporting it under another name, called a second time',
    startTs: append(
      `import { go } from './shim';\nconst again = go(${NO_OP_OPTIONS});\nawait again.started;\n`,
    ),
    files: {
      [SHIM]: "export { startProductionServer as go } from './listen-first';\n",
    },
    expected: ONE_CALL,
  },
  {
    shape: "ISSUE-218 review: a computed override key ['refuse' + 'Role']",
    startTs: edit(
      REFUSAL,
      `${REFUSAL}  ['refuse' + 'Role']: async () => {},\n`,
    ),
    expected: OVERRIDDEN,
  },
  // Shapes the ISSUE-206 review found caught, kept caught.
  {
    shape: 'refuseRole through a shorthand variable',
    startTs: edit(REFUSAL, '  refuseRole,\n').replace(
      CALL,
      `const refuseRole = async () => {};\n${CALL}`,
    ),
    expected: MISSING,
  },
  {
    shape: 'a wrapper function around a second call',
    startTs: append(
      `const boot = () => startProductionServer(${NO_OP_OPTIONS});\nawait boot().started;\n`,
    ),
    expected: ONE_CALL,
  },
  {
    shape: 'a dynamic-import second call',
    startTs: append(
      `const lf = await import('./listen-first');\nawait lf.startProductionServer(${NO_OP_OPTIONS}).started;\n`,
    ),
    expected: bypass('import('),
  },
  {
    shape:
      'a namespace-style (await import(...)).startProductionServer( second call',
    startTs: append(
      `await (await import('./listen-first')).startProductionServer(${NO_OP_OPTIONS}).started;\n`,
    ),
    expected: bypass('import('),
  },
  {
    shape: 'a shadowed refuseSchemaAlteringRole parameter around the call',
    startTs: edit(
      CALL,
      'const { server, started } = ((refuseSchemaAlteringRole: (...args: unknown[]) => Promise<void>) => startProductionServer({\n',
    ).replace(
      "  host: '0.0.0.0',\n});\n",
      "  host: '0.0.0.0',\n}))(async () => {});\n",
    ),
    expected: ONE_CALL,
  },
  {
    shape: 'the refusal only in a string, with a no-op key',
    startTs: edit(REFUSAL, '  refuseRole: async () => {},\n').replace(
      CALL,
      `const note = "refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web'),";\n${CALL}`,
    ),
    expected: MISSING,
  },
  {
    shape: 'the refusal only in a block comment, with a no-op key',
    startTs: edit(
      REFUSAL,
      `  /* ${REFUSAL.trim()} */ refuseRole: async () => {},\n`,
    ),
    expected: MISSING,
  },
  {
    shape: 'the refusal only in a trailing comment, with a no-op key',
    startTs: edit(
      REFUSAL,
      `  refuseRole: async () => {}, // ${REFUSAL.trim()}\n`,
    ),
    expected: MISSING,
  },
  {
    shape: "a quoted 'refuseRole' key overriding the refusal",
    startTs: edit(REFUSAL, `${REFUSAL}  'refuseRole': async () => {},\n`),
    expected: OVERRIDDEN,
  },
];

describeRows(
  'findRuntimeRoleGateProblem allows harmless edits (ISSUE-218)',
  'report no problem',
  harmless,
);

describeRows(
  'findRuntimeRoleGateProblem refuses every bypass (ISSUE-193, ISSUE-206, ISSUE-218)',
  'report the bypass',
  refused,
);

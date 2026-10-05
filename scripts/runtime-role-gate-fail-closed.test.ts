import { setupRitewayBun } from 'riteway/bun';
import {
  append,
  BOOT,
  bypass,
  edit,
  lineCount,
  NO_OP_OPTIONS,
  NOT_FROM_DB,
  ONE_CALL,
  realStart,
  type Row,
  START_IMPORT,
  unparsed,
  unresolved,
  describeRows,
} from './runtime-role-gate.test-support';

setupRitewayBun();

// The gate fails closed on a start.ts it cannot read (ISSUE-221), and
// refuses CommonJS loads (ISSUE-222), any use of the @offense-demo/db refusal
// beyond the one wiring (ISSUE-223), and prepare, listen or a second start
// reached by another access form or a side-effect module (ISSUE-224).
const refused: readonly Row[] = [
  // ISSUE-221: fail closed on a start.ts that does not parse or resolve.
  {
    shape: 'ISSUE-221 review: an appended const = = ;;; }}}',
    startTs: append('const = = ;;; }}}\n'),
    expected: unparsed('Variable declaration expected.', lineCount),
  },
  {
    shape: 'ISSUE-221 review: an unterminated template literal',
    startTs: append('const note = `unterminated\n'),
    // TypeScript reports an unterminated template at the end of the file.
    expected: unparsed('Unterminated template literal.', lineCount + 1),
  },
  {
    shape: 'ISSUE-221 review: leading garbage @@@ ###',
    startTs: `@@@ ###\n${realStart}`,
    expected: unparsed('Invalid character.', 1),
  },
  {
    shape: 'ISSUE-221: a relative import that does not resolve',
    startTs: edit(START_IMPORT, `${START_IMPORT}import './missing-module';\n`),
    expected: unresolved('./missing-module'),
  },
  {
    shape: 'ISSUE-221: a package import that does not resolve',
    startTs: edit(
      START_IMPORT,
      `${START_IMPORT}import { nothing } from '@offense-demo/no-such-package';\n`,
    ),
    expected: unresolved('@offense-demo/no-such-package'),
  },
  // ISSUE-222: CommonJS second calls.
  {
    shape: 'ISSUE-222 review: a require() of ./listen-first called again',
    startTs: append(
      `const { startProductionServer: again } = require('./listen-first');\nagain(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('require('),
  },
  {
    shape: 'ISSUE-222: module.require of ./listen-first',
    startTs: append(
      `const lf = module.require('./listen-first');\nlf.startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('module.require('),
  },
  {
    shape: 'ISSUE-222: createRequire of ./listen-first',
    startTs: edit(
      START_IMPORT,
      `${START_IMPORT}import { createRequire } from 'node:module';\n`,
    ).concat(
      `const load = createRequire(import.meta.url);\nload('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('createRequire('),
  },
  // ISSUE-223: refuseSchemaAlteringRole only as the one refusal (main's rule).
  {
    shape: 'ISSUE-223 review: void refuseSchemaAlteringRole;',
    startTs: append('void refuseSchemaAlteringRole;\n'),
    expected: NOT_FROM_DB,
  },
  {
    shape: "ISSUE-223 review: a second refuseSchemaAlteringRole(app, 'x') call",
    startTs: append("await refuseSchemaAlteringRole(app, 'x' as never);\n"),
    expected: NOT_FROM_DB,
  },
  // ISSUE-224: prepare and listen by any access form, and side-effect modules.
  {
    shape: "ISSUE-224 review: server['listen'](3000)",
    startTs: append("server['listen'](3000);\n"),
    expected: bypass('.listen('),
  },
  {
    shape: 'ISSUE-224 review: const { listen } = server; listen(3000)',
    startTs: append('const { listen } = server;\nlisten(3000);\n'),
    expected: bypass('.listen('),
  },
  {
    shape: "ISSUE-224 review: await nextApp['prepare']()",
    startTs: append("await nextApp['prepare']();\n"),
    expected: bypass('nextApp.prepare('),
  },
  {
    shape: 'ISSUE-224 review: const { prepare } = nextApp; await prepare()',
    startTs: append('const { prepare } = nextApp;\nawait prepare();\n'),
    expected: bypass('nextApp.prepare('),
  },
  {
    shape: 'ISSUE-224 review: const n2 = nextApp; await n2.prepare()',
    startTs: append('const n2 = nextApp;\nawait n2.prepare();\n'),
    expected: bypass('nextApp.prepare('),
  },
  {
    shape: "ISSUE-224: nextApp['getRequestHandler']()",
    startTs: append("nextApp['getRequestHandler']();\n"),
    expected: bypass('getRequestHandler('),
  },
  {
    shape:
      "ISSUE-224 review: import './boot2' where boot2 calls startProductionServer",
    startTs: edit(START_IMPORT, `${START_IMPORT}import './boot2';\n`),
    files: {
      [BOOT]:
        "import { startProductionServer } from './listen-first';\nstartProductionServer({} as never);\n",
    },
    expected: ONE_CALL,
  },
];

describeRows(
  'findRuntimeRoleGateProblem fails closed (ISSUE-221, ISSUE-222, ISSUE-223, ISSUE-224)',
  'report the problem, never pass',
  refused,
);

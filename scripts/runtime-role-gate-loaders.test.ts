import { setupRitewayBun } from 'riteway/bun';
import {
  append,
  bypass,
  describeRows,
  edit,
  NO_OP_OPTIONS,
  type Row,
  START_IMPORT,
} from './runtime-role-gate.test-support';

setupRitewayBun();

// eval and Function are refused however they are reached, not only as bare
// globals (ISSUE-240), and so is every Module loader entry point, by any
// owner, key or import (ISSUE-258), in start.ts and in a module it loads.
const BOOT3 = 'apps/web/src/server/boot3.ts';
const loads = (path: string, token: string) =>
  `start.ts loads ${path}, which bypasses the start-up gate with ${token}; start only through startProductionServer (ISSUE-228)`;
const withModule = (line: string) =>
  edit(START_IMPORT, `${START_IMPORT}${line}\n`);
const MODULE_IMPORT = "import Module from 'node:module';";
const START_CALL = `.startProductionServer(${NO_OP_OPTIONS});\n`;
const LOAD_SOURCE = `"require('./listen-first').startProductionServer({})"`;

const harmless: readonly Row[] = [
  {
    shape: 'ISSUE-240: object keys named eval and Function',
    startTs: append(
      "const opts = { eval: false, Function: 'x' };\nvoid opts;\n",
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-258: an interface with wrap and register members',
    startTs: append(
      'interface Opts {\n  wrap: string;\n  register: boolean;\n}\nexport type { Opts };\n',
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-258: a local function named wrap',
    startTs: append(
      'function wrap(x: number) {\n  return x;\n}\nvoid wrap(1);\n',
    ),
    expected: null,
  },
];

const refused: readonly Row[] = [
  // ISSUE-240: eval and Function through globalThis or destructuring.
  {
    shape: 'ISSUE-240 review: globalThis.eval(...)',
    startTs: append('globalThis.eval("import(\'./listen-first\')");\n'),
    expected: bypass('eval('),
  },
  {
    shape: "ISSUE-240 review: globalThis['eval'](...)",
    startTs: append("globalThis['eval'](\"import('./listen-first')\");\n"),
    expected: bypass('eval('),
  },
  {
    shape: 'ISSUE-240 review: const { eval } = globalThis, then eval(...)',
    startTs: append(
      'const { eval } = globalThis;\neval("import(\'./listen-first\')");\n',
    ),
    expected: bypass('eval('),
  },
  {
    shape: 'ISSUE-240 review: new globalThis.Function(...)',
    startTs: append(
      'new globalThis.Function("return import(\'./listen-first\')")();\n',
    ),
    expected: bypass('Function('),
  },
  {
    shape:
      'ISSUE-240 review: const { Function: F } = globalThis, then new F(...)',
    startTs: append(
      'const { Function: F } = globalThis;\nnew F("return import(\'./listen-first\')")();\n',
    ),
    expected: bypass('Function('),
  },
  {
    shape: 'ISSUE-240: globalThis.eval in a module start.ts loads',
    startTs: withModule("import './boot3';"),
    files: { [BOOT3]: 'globalThis.eval("import(\'./listen-first\')");\n' },
    expected: loads(BOOT3, 'eval('),
  },
  // ISSUE-258: Module loader entry points, however reached.
  {
    shape: "ISSUE-258 review: Module._load('./listen-first')",
    startTs: withModule(MODULE_IMPORT).concat(
      `Module._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: "ISSUE-258: Module['_load'](...)",
    startTs: withModule(MODULE_IMPORT).concat(
      `Module['_load']('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-258: const { _load: load } = Module, then load(...)',
    startTs: withModule(MODULE_IMPORT).concat(
      `const { _load: load } = Module;\nload('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: "ISSUE-258: import { _load } from 'node:module'",
    startTs: withModule("import { _load } from 'node:module';").concat(
      `_load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-258: _load re-exported by a shim, then _load(...)',
    startTs: withModule("import { _load } from './shim';").concat(
      `_load('./listen-first', null)${START_CALL}`,
    ),
    files: {
      'apps/web/src/server/shim.ts': "export { _load } from 'node:module';\n",
    },
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-258: Module._resolveFilename',
    startTs: withModule(MODULE_IMPORT).concat(
      "void Module._resolveFilename('./listen-first', null);\n",
    ),
    expected: bypass('node:module._resolveFilename'),
  },
  {
    shape: 'ISSUE-258: Module.wrap',
    startTs: withModule(MODULE_IMPORT).concat(
      `void Module.wrap(${LOAD_SOURCE});\n`,
    ),
    expected: bypass('node:module.wrap'),
  },
  {
    shape: "ISSUE-258: import { wrap } from 'node:module'",
    startTs: withModule("import { wrap } from 'node:module';").concat(
      `void wrap(${LOAD_SOURCE});\n`,
    ),
    expected: bypass('node:module.wrap'),
  },
  {
    shape: 'ISSUE-258: new Module(...)._compile(source)',
    startTs: withModule(MODULE_IMPORT).concat(
      `new Module('x')._compile(${LOAD_SOURCE}, 'x.js');\n`,
    ),
    expected: bypass('node:module._compile'),
  },
  {
    shape: 'ISSUE-258: Module.prototype._compile.call(...)',
    startTs: withModule(MODULE_IMPORT).concat(
      `Module.prototype._compile.call(new Module('x'), ${LOAD_SOURCE}, 'x.js');\n`,
    ),
    expected: bypass('node:module._compile'),
  },
  {
    shape: 'ISSUE-258: Module.register loader hooks',
    startTs: withModule(MODULE_IMPORT).concat(
      "Module.register('./hooks.mjs', import.meta.url);\n",
    ),
    expected: bypass('node:module.register'),
  },
  {
    shape: 'ISSUE-258: Module.registerHooks',
    startTs: withModule(MODULE_IMPORT).concat('Module.registerHooks({});\n'),
    expected: bypass('node:module.registerHooks'),
  },
  {
    shape: 'ISSUE-258: Module.runMain',
    startTs: withModule(MODULE_IMPORT).concat('Module.runMain();\n'),
    expected: bypass('node:module.runMain'),
  },
  {
    shape: 'ISSUE-258: namespace m.Module, then _compile',
    startTs: withModule("import * as nm from 'node:module';").concat(
      `new nm.Module('x')._compile(${LOAD_SOURCE}, 'x.js');\n`,
    ),
    expected: bypass('node:module._compile'),
  },
  {
    shape: "ISSUE-258: process.getBuiltinModule('module'), then _load",
    startTs: append(
      `const M = process.getBuiltinModule('module');\nM._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('process.getBuiltinModule'),
  },
  {
    shape: 'ISSUE-258: Module._load in a module start.ts loads',
    startTs: withModule("import './boot3';"),
    files: {
      [BOOT3]: `${MODULE_IMPORT}\nModule._load('./listen-first', null)${START_CALL}`,
    },
    expected: loads(BOOT3, 'node:module._load'),
  },
];

describeRows(
  'findRuntimeRoleGateProblem ignores keys and locals named like loaders (ISSUE-240, ISSUE-258)',
  'report no problem',
  harmless,
);

describeRows(
  'findRuntimeRoleGateProblem refuses eval, Function and Module loaders however reached (ISSUE-240, ISSUE-258)',
  'report the bypass',
  refused,
);

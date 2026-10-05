import { setupRitewayBun } from 'riteway/bun';
import {
  append,
  bypass,
  edit,
  NO_OP_OPTIONS,
  type Row,
  START_IMPORT,
  describeRows,
} from './runtime-role-gate.test-support';

setupRitewayBun();

// Only the real CommonJS require binding is a bypass, never a property,
// member or local that happens to be named require (ISSUE-227). A module
// start.ts loads may not listen or prepare Next either, and require-like
// escapes (import equals, globalThis['require'], eval, new Function) are
// refused (ISSUE-228).
const BOOT3 = 'apps/web/src/server/boot3.ts';
const loads = (path: string, token: string) =>
  `start.ts loads ${path}, which bypasses the start-up gate with ${token}; start only through startProductionServer (ISSUE-228)`;
const withBoot3 = `${START_IMPORT}import './boot3';\n`;
const CALL_LISTEN_FIRST = `('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`;

const harmless: readonly Row[] = [
  {
    shape: 'ISSUE-227 review: an object key named require',
    startTs: append('const c = { require: 2 };\nvoid c;\n'),
    expected: null,
  },
  {
    shape: 'ISSUE-227 review: an interface member named require',
    startTs: append(
      'interface I {\n  require: string;\n}\nexport type { I };\n',
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-227 review: a local function named require',
    startTs: append('function require() {}\nvoid require;\n'),
    expected: null,
  },
  {
    shape: 'ISSUE-227: a parameter named require',
    startTs: append(
      'const bump = (require: number) => require + 1;\nvoid bump;\n',
    ),
    expected: null,
  },
];

const refused: readonly Row[] = [
  // ISSUE-239: createRequire refused under any name or access form, as main
  // did, in start.ts and in a module it loads.
  {
    shape:
      "ISSUE-239 review: import { createRequire as cr } from 'node:module'",
    startTs: edit(
      START_IMPORT,
      `${START_IMPORT}import { createRequire as cr } from 'node:module';\n`,
    ).concat(`cr(import.meta.url)${CALL_LISTEN_FIRST}`),
    expected: bypass('createRequire('),
  },
  {
    shape: 'ISSUE-239 review: import * as m, then m.createRequire(...)',
    startTs: edit(
      START_IMPORT,
      `${START_IMPORT}import * as m from 'node:module';\n`,
    ).concat(`m.createRequire(import.meta.url)${CALL_LISTEN_FIRST}`),
    expected: bypass('createRequire('),
  },
  {
    shape: "ISSUE-239: import * as m, then m['createRequire'](...)",
    startTs: edit(
      START_IMPORT,
      `${START_IMPORT}import * as m from 'node:module';\n`,
    ).concat(`m['createRequire'](import.meta.url)${CALL_LISTEN_FIRST}`),
    expected: bypass('createRequire('),
  },
  {
    shape:
      "ISSUE-239 review: const { createRequire: cr } = process.getBuiltinModule('module')",
    startTs: append(
      `const { createRequire: cr } = process.getBuiltinModule('module');\ncr(import.meta.url)${CALL_LISTEN_FIRST}`,
    ),
    expected: bypass('createRequire('),
  },
  {
    shape:
      "ISSUE-239 review: process.getBuiltinModule('module').createRequire(...)",
    startTs: append(
      `process.getBuiltinModule('module').createRequire(import.meta.url)${CALL_LISTEN_FIRST}`,
    ),
    expected: bypass('createRequire('),
  },
  {
    shape: 'ISSUE-239: an aliased createRequire in a module start.ts loads',
    startTs: edit(START_IMPORT, withBoot3),
    files: {
      [BOOT3]: `import { createRequire as cr } from 'node:module';\ncr(import.meta.url)${CALL_LISTEN_FIRST}`,
    },
    expected: loads(BOOT3, 'createRequire('),
  },
  // ISSUE-235: every require member read is a bypass, as on main, and a
  // declared (ambient) require or module is still the host's own binding.
  {
    shape: 'ISSUE-235 review: const g = globalThis; g.require(...)',
    startTs: append(
      `const g = globalThis;\ng.require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('g.require('),
  },
  {
    shape: 'ISSUE-235 review: const m = module; m.require(...)',
    startTs: append(
      `const m = module;\nm.require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('m.require('),
  },
  {
    shape: 'ISSUE-235 review: process.mainModule!.require(...)',
    startTs: append(
      `process.mainModule!.require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('.require('),
  },
  {
    shape: 'ISSUE-235 review: (0, module).require(...)',
    startTs: append(
      `(0, module).require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('.require('),
  },
  {
    shape: 'ISSUE-235 review: Module.prototype.require.call(...)',
    startTs: append(
      `Module.prototype.require.call(module, './listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('.require('),
  },
  {
    shape: "ISSUE-235: a local object's require member called, as main refused",
    startTs: append('const c = { require: () => 2 };\nc.require();\n'),
    expected: bypass('c.require('),
  },
  {
    shape: 'ISSUE-235 review: declare const require, then require(...)',
    startTs: append(
      `declare const require: (id: string) => any;\nrequire('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('require('),
  },
  {
    shape:
      'ISSUE-235 review: declare global { var require }, then require(...)',
    startTs: append(
      `declare global {\n  var require: (id: string) => any;\n}\nrequire('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('require('),
  },
  {
    shape:
      'ISSUE-235 review: declare const module, then a value read of require',
    startTs: append(
      `declare const module: any;\nconst load = module['require'];\nload('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('module.require('),
  },
  {
    shape: "ISSUE-227: require('./listen-first') is still a bypass",
    startTs: append("require('./listen-first');\n"),
    expected: bypass('require('),
  },
  {
    shape: 'ISSUE-227: require passed around as a value',
    startTs: append(
      `const load = require;\nload('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('require('),
  },
  {
    shape: 'ISSUE-227: require in a shorthand property',
    startTs: append(
      `const o = { require };\no.require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('require('),
  },
  {
    shape: 'ISSUE-227: import.meta.require',
    startTs: append(
      `import.meta.require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('import.meta.require('),
  },
  {
    shape: 'ISSUE-228 review: a side-effect module that listens',
    startTs: edit(START_IMPORT, withBoot3),
    files: {
      [BOOT3]:
        "import http from 'node:http';\nhttp.createServer().listen(9);\n",
    },
    expected: loads(BOOT3, '.listen('),
  },
  {
    shape: 'ISSUE-228 review: a side-effect module that prepares Next',
    startTs: edit(START_IMPORT, withBoot3),
    files: {
      [BOOT3]:
        "import next from 'next';\nawait next({ dev: false }).prepare();\n",
    },
    expected: loads(BOOT3, 'nextApp.prepare('),
  },
  {
    shape: 'ISSUE-228: a side-effect module that requires listen-first',
    startTs: edit(START_IMPORT, withBoot3),
    files: {
      [BOOT3]: `require('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    },
    expected: loads(BOOT3, 'require('),
  },
  {
    shape: 'ISSUE-228: import equals',
    startTs: append(
      `import lf = require('./listen-first');\nlf.startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('require('),
  },
  {
    shape: "ISSUE-228: globalThis['require']",
    startTs: append(
      `globalThis['require']('./listen-first').startProductionServer(${NO_OP_OPTIONS});\n`,
    ),
    expected: bypass('globalThis.require('),
  },
  {
    shape: 'ISSUE-228: eval of a dynamic import',
    startTs: append('eval("import(\'./listen-first\')");\n'),
    expected: bypass('eval('),
  },
  {
    shape: 'ISSUE-228: new Function returning a dynamic import',
    startTs: append('new Function("return import(\'./listen-first\')")();\n'),
    expected: bypass('Function('),
  },
];

describeRows(
  'findRuntimeRoleGateProblem ignores names that are not require (ISSUE-227)',
  'report no problem',
  harmless,
);

describeRows(
  'findRuntimeRoleGateProblem refuses real require and loaded modules that bypass (ISSUE-227, ISSUE-228)',
  'report the bypass',
  refused,
);

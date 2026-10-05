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

// Module internals are refused only when they resolve to the real `module`
// or `node:module` value binding, never by name alone: a local, field or
// key named `_cache`, or a type-only Module import, passes (ISSUE-262).
// `.constructor` (Function from any function) and `vm` / `node:vm` are
// refused (ISSUE-263).
const BOOT4 = 'apps/web/src/server/boot4.ts';
const SHIM = 'apps/web/src/server/shim.ts';
const loads = (path: string, token: string) =>
  `start.ts loads ${path}, which bypasses the start-up gate with ${token}; start only through startProductionServer (ISSUE-228)`;
const withImport = (line: string) =>
  edit(START_IMPORT, `${START_IMPORT}${line}\n`);
const START_CALL = `.startProductionServer(${NO_OP_OPTIONS});\n`;
const COMPILE = `._compile("require('./listen-first')", 'x.js');\n`;
const UNDERSCORE_LOCALS = [
  'const _cache = new Map<string, number>();',
  'class Store {',
  '  _cache = new Map<string, number>();',
  '  size() {',
  '    return this._cache.size;',
  '  }',
  '}',
  'const keys = { _cache: 1, _load: 2 };',
  'void [_cache.size, new Store().size(), keys._cache];',
  '',
].join('\n');

const harmless: readonly Row[] = [
  // ISSUE-266: a .constructor value that is never called or new'd passes.
  {
    shape: 'ISSUE-266 review: err.constructor.name',
    startTs: append(
      'class AppError extends Error {}\nconst err = new AppError();\nvoid err.constructor.name;\n',
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-266 review: value.constructor === Object',
    startTs: append(
      'const value = {};\nvoid (value.constructor === Object);\n',
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-266 review: a class reading this.constructor.name',
    startTs: append(
      'class Base {\n  kind() {\n    return this.constructor.name;\n  }\n}\nvoid new Base().kind();\n',
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-266: a .constructor bound to a variable that is never called',
    startTs: append(
      'const err = new Error();\nconst Ctor = err.constructor;\nvoid Ctor.name;\n',
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-262 review: a local, class field and object key named _cache',
    startTs: append(UNDERSCORE_LOCALS),
    expected: null,
  },
  {
    shape:
      'ISSUE-262 review: the same underscore names in a module start.ts loads',
    startTs: withImport("import './boot4';"),
    files: { [BOOT4]: `${UNDERSCORE_LOCALS}export {};\n` },
    expected: null,
  },
  {
    shape: "ISSUE-262 review: import type Module from 'node:module'",
    startTs: withImport("import type Module from 'node:module';").concat(
      'let unused: Module | undefined;\nvoid unused;\n',
    ),
    expected: null,
  },
  {
    shape: "ISSUE-262 review: import { type Module } from 'node:module'",
    startTs: withImport("import { type Module } from 'node:module';").concat(
      'let unused: Module | undefined;\nvoid unused;\n',
    ),
    expected: null,
  },
  {
    shape: "ISSUE-262: import type * as nm from 'node:module'",
    startTs: withImport("import type * as nm from 'node:module';").concat(
      'let unused: typeof nm | undefined;\nvoid unused;\n',
    ),
    expected: null,
  },
  {
    shape: "ISSUE-263: import type { Script } from 'node:vm'",
    startTs: withImport("import type { Script } from 'node:vm';").concat(
      'let unused: Script | undefined;\nvoid unused;\n',
    ),
    expected: null,
  },
];

// ISSUE-268: the cannot-see list in scripts/runtime-role-gate.ts names these
// forms. Each passes because the .constructor read is the owner of a member,
// a tagged template, a call argument, a collection element or an object
// property rather than the callee; a row turning red means the header list is stale.
const FN = 'const fn = () => 1;\n';
const documentedLimits: readonly Row[] = [
  {
    shape: "ISSUE-268: fn.constructor.call(null, 'return 1')",
    startTs: append(`${FN}void fn.constructor.call(null, 'return 1');\n`),
    expected: null,
  },
  {
    shape: "ISSUE-268: fn.constructor.apply(null, ['return 1'])",
    startTs: append(`${FN}void fn.constructor.apply(null, ['return 1']);\n`),
    expected: null,
  },
  {
    shape: "ISSUE-268: fn.constructor.bind(null)('return 1')",
    startTs: append(`${FN}void fn.constructor.bind(null)('return 1');\n`),
    expected: null,
  },
  {
    shape: "ISSUE-268: Reflect.apply(fn.constructor, null, ['return 1'])",
    startTs: append(
      `${FN}void Reflect.apply(fn.constructor, null, ['return 1']);\n`,
    ),
    expected: null,
  },
  {
    shape: 'ISSUE-268: a tagged template on fn.constructor',
    startTs: append(`${FN}void fn.constructor\`return 1\`;\n`),
    expected: null,
  },
  {
    shape: "ISSUE-268: [fn.constructor][0]('return 1')",
    startTs: append(`${FN}void [fn.constructor][0]!('return 1');\n`),
    expected: null,
  },
  {
    shape: "ISSUE-268: ({ f: fn.constructor }).f('return 1')",
    startTs: append(`${FN}void ({ f: fn.constructor }).f('return 1');\n`),
    expected: null,
  },
  {
    shape: "ISSUE-268: Reflect.construct(fn.constructor, ['return 1'])",
    startTs: append(
      `${FN}void Reflect.construct(fn.constructor, ['return 1']);\n`,
    ),
    expected: null,
  },
];

const refused: readonly Row[] = [
  // ISSUE-267: resolution sees through every operand that can yield Module.
  {
    shape: 'ISSUE-267 review: (0, M)._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n(0, M)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267 review: (c ? M : M)._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n(c ? M : M)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267: (c ? 0 : M)._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n(c ? 0 : M)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267 review: (M || 0)._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n(M || 0)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267: (0 ?? M)._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n(0 ?? M)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267: (c && M)._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n(c && M)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267: ((M))._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\n((M))._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-267: a const bound to c ? M : 0, then Alias._load',
    startTs: withImport("import M from 'node:module';").concat(
      `declare const c: boolean;\nconst Alias = c ? M : 0;\n(Alias as typeof M)._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  // ISSUE-266: a .constructor value that is called or new'd is refused.
  {
    shape: 'ISSUE-266 review: const F = fn.constructor; F(src)',
    startTs: append(
      "const fn = () => 1;\nconst F = fn.constructor;\nvoid F('return 1');\n",
    ),
    expected: bypass('.constructor'),
  },
  {
    shape: 'ISSUE-266 review: const { constructor: F } = fn, never called',
    startTs: append(
      'const fn = () => 1;\nconst { constructor: F } = fn;\nvoid F;\n',
    ),
    expected: bypass('.constructor'),
  },
  {
    shape: 'ISSUE-266: new x.constructor(src)',
    startTs: append(
      "const fn = () => 1;\nvoid new fn.constructor('return 1');\n",
    ),
    expected: bypass('.constructor'),
  },
  {
    shape: 'ISSUE-266: x.constructor.constructor(src)',
    startTs: append(
      "const v = {};\nvoid v.constructor.constructor('return 1');\n",
    ),
    expected: bypass('.constructor'),
  },
  {
    shape: 'ISSUE-266: (0, fn.constructor)(src)',
    startTs: append(
      "const fn = () => 1;\nvoid (0, fn.constructor)('return 1');\n",
    ),
    expected: bypass('.constructor'),
  },
  // ISSUE-262: resolution reaches the real binding through aliases.
  {
    shape: 'ISSUE-262: a const alias of Module, then M._load(...)',
    startTs: withImport("import Module from 'node:module';").concat(
      `const M = Module;\nM._load('./listen-first', null)${START_CALL}`,
    ),
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-262: const { Module: Mod } = nm, then new Mod(...)._compile',
    startTs: withImport("import * as nm from 'node:module';").concat(
      `const { Module: Mod } = nm;\nnew Mod('x')${COMPILE}`,
    ),
    // The destructure of Module from the namespace is the first refusal.
    expected: bypass('node:module.Module'),
  },
  {
    shape: 'ISSUE-262: a shim renaming _load, then go(...)',
    startTs: withImport("import { go } from './shim';").concat(
      `go('./listen-first', null)${START_CALL}`,
    ),
    files: { [SHIM]: "export { _load as go } from 'node:module';\n" },
    expected: bypass('node:module._load'),
  },
  {
    shape: 'ISSUE-262 review: an uncalled q.Module names the member',
    startTs: withImport("import * as q from 'node:module';").concat(
      'void q.Module;\n',
    ),
    expected: bypass('node:module.Module'),
  },
  {
    shape: "ISSUE-262: import { getBuiltinModule } from 'node:process'",
    startTs: withImport(
      "import { getBuiltinModule } from 'node:process';",
    ).concat("void getBuiltinModule('vm');\n"),
    expected: bypass('process.getBuiltinModule'),
  },
  // ISSUE-263: Function through any function's constructor.
  {
    shape: "ISSUE-263 review: (() => 1).constructor('return 1')()",
    startTs: append("(() => 1).constructor('return 1')();\n"),
    expected: bypass('.constructor'),
  },
  {
    shape: "ISSUE-263: (async () => 1)['constructor'](...)",
    startTs: append("void (async () => 1)['constructor']('return 1');\n"),
    expected: bypass('.constructor'),
  },
  {
    shape: 'ISSUE-263: const { constructor: F } = () => 1, then F(...)',
    startTs: append(
      "const { constructor: F } = () => 1;\nvoid F('return 1');\n",
    ),
    expected: bypass('.constructor'),
  },
  {
    shape: 'ISSUE-263: .constructor in a module start.ts loads',
    startTs: withImport("import './boot4';"),
    files: { [BOOT4]: "(() => 1).constructor('return 1')();\n" },
    expected: loads(BOOT4, '.constructor'),
  },
  // ISSUE-263: vm and node:vm.
  {
    shape:
      "ISSUE-263 review: import vm from 'node:vm'; vm.runInThisContext(...)",
    startTs: withImport("import vm from 'node:vm';").concat(
      'vm.runInThisContext("import(\'./listen-first\')");\n',
    ),
    expected: bypass('node:vm'),
  },
  {
    shape:
      "ISSUE-263 review: import { Script } from 'node:vm'; new Script(...)",
    startTs: withImport("import { Script } from 'node:vm';").concat(
      "void new Script('1');\n",
    ),
    expected: bypass('node:vm'),
  },
  {
    shape: "ISSUE-263: import { compileFunction as cf } from 'vm'",
    startTs: withImport("import { compileFunction as cf } from 'vm';").concat(
      "void cf('return 1');\n",
    ),
    expected: bypass('node:vm'),
  },
  {
    shape: "ISSUE-263: import * as v from 'node:vm'",
    startTs: withImport("import * as v from 'node:vm';").concat(
      "void v.runInNewContext('1');\n",
    ),
    expected: bypass('node:vm'),
  },
  {
    shape: 'ISSUE-263: node:vm re-exported by a shim',
    startTs: withImport("import { run } from './shim';").concat(
      "void run('1');\n",
    ),
    files: {
      [SHIM]: "export { runInThisContext as run } from 'node:vm';\n",
    },
    expected: bypass('node:vm'),
  },
];

describeRows(
  'findRuntimeRoleGateProblem ignores underscore locals and type-only imports (ISSUE-262, ISSUE-263)',
  'report no problem',
  harmless,
);

describeRows(
  'findRuntimeRoleGateProblem passes the .constructor forms its header lists as unseen (ISSUE-268)',
  'report no problem, as documented',
  documentedLimits,
);

describeRows(
  'findRuntimeRoleGateProblem refuses resolved Module internals, .constructor and node:vm (ISSUE-262, ISSUE-263)',
  'report the bypass',
  refused,
);

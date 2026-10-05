import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { bypassToken } from './runtime-role-gate-bypass';

/**
 * ISSUE-39, ISSUE-193, ISSUE-206, ISSUE-218: production start-up refuses a
 * DATABASE_URL role that can create or alter schema objects before Next
 * prepares, and no request reaches Next before both finish. That ordering
 * lives in startProductionServer (apps/web/src/server/listen-first.ts,
 * tested there). This reads start.ts as a TypeScript program, resolving
 * relative imports and every symbol through aliases and re-exports, so
 * comments and formatting never matter and no alias, shim, `.call`,
 * optional or second call slips past a text match. start.ts must:
 * - parse without a syntax error, and resolve every import (ISSUE-221);
 * - never compose, prepare, listen, require, eval or import dynamically
 *   on its own, by any access form: `.`, `['…']` or destructuring
 *   (ISSUE-222, ISSUE-224). The host's require binding (a call or value
 *   reference to a require with no non-ambient declaration), any read of a
 *   `require` member off any owner, an import equals or a require-named
 *   import is refused; a key, interface member or local declared with
 *   that name is not (ISSUE-227, ISSUE-235). Any identifier or member
 *   named createRequire is refused, however it is imported or reached
 *   (ISSUE-239). eval and Function are refused as bare globals, as members
 *   off any owner and as destructured keys (ISSUE-240). Module's loader
 *   entry points (`_load`, `_resolveFilename`, `_compile`, `wrap`,
 *   `_extensions`, `_cache`, `runMain`, `register`, `registerHooks`,
 *   `Module` and the other underscore internals) are refused when they
 *   resolve to the real `module` / `node:module` value binding: a member,
 *   destructured key or import of it, through aliases, re-export shims,
 *   const aliases, `new Module(...)`, `Module.prototype` or a
 *   `getBuiltinModule` result. A local, field or key with the same name,
 *   or a type-only import, passes (ISSUE-258, ISSUE-262). Any
 *   `getBuiltinModule` read or import, any non-type import or re-export
 *   of `vm` / `node:vm`, a destructured `constructor` key, and a
 *   `.constructor` value that is invoked (called or new'd, directly or
 *   through a variable invoked later in the file: Function from any
 *   function) is refused; a `.constructor` read that is never invoked,
 *   such as `err.constructor.name`, passes (ISSUE-263, ISSUE-266).
 *   Resolution sees through parentheses, commas, conditionals and
 *   `&&` / `||` / `??`, checking every operand that can yield the value
 *   (ISSUE-267). The same holds for every relative
 *   module start.ts loads, outside listen-first.ts's own imports
 *   (ISSUE-228);
 * - import startProductionServer, unaliased, from ./listen-first;
 * - be the only module that references it (so no side-effect import can
 *   start a second server), exactly once, as the direct callee of the one
 *   call (ISSUE-224);
 * - pass that call one object literal that sets refuseRole once, by a
 *   plain key, with no spread or computed key;
 * - set it to `() => refuseSchemaAlteringRole(app, 'offense_demo_web')`, where
 *   refuseSchemaAlteringRole is @offense-demo/db's import, not a local or shadow,
 *   and used nowhere else (ISSUE-223);
 * - await the `started` the call returns.
 * `files` overlays repository-relative paths (a test's shim module).
 *
 * This contract is fixed (ISSUE-263): anything the gate cannot see is a
 * documented limit below, not a reason for another round. What it cannot
 * see, each a way to start a second, unguarded server it would pass:
 * - names built at runtime: computed members (`globalThis['ev' + 'al']`,
 *   `server['li' + 'sten']`), `Reflect.get`, `Object.values(Module)` or any
 *   value reached through data rather than a spelled-out name;
 * - the real Module reached through a value the checker cannot follow:
 *   a function's return, a parameter, an object property or collection
 *   (`const box = { M: Module }; box.M._load(...)`), a `let` reassigned
 *   later, or anything else that is not an import, alias, const,
 *   destructure, member, `new` or `getBuiltinModule` of it;
 * - a `.constructor` value that is invoked, but not as the direct callee
 *   of a call or `new` (ISSUE-268): passed as an argument (to a function
 *   that calls it, or to `Reflect.apply` / `Reflect.construct`); the owner
 *   of a member (`fn.constructor.call(null, src)`, `.apply(...)`,
 *   `.bind(null)(src)`) or the tag of a template (``fn.constructor`src` ``);
 *   held as a collection element or object property
 *   (`[fn.constructor][0](src)`, `({ f: fn.constructor }).f(src)`);
 *   re-bound through a second variable (`const G = F; G(...)`); or invoked
 *   in another module;
 * - code outside start.ts's relative import graph: package imports
 *   (`@offense-demo/*`, `node_modules`) are resolved but never loaded or scanned,
 *   so a dependency that loads listen-first itself is invisible;
 * - listen-first.ts and its own imports, the gate's implementation, which
 *   listen-first.test.ts tests instead;
 * - loaders configured outside the source: Bun `preload` in bunfig.toml,
 *   `--preload`, `--require` or `--import` flags, NODE_OPTIONS and
 *   `Bun.plugin`;
 * - other processes and threads: `new Worker(...)`, `Bun.spawn`,
 *   `child_process`, and native code through `process.dlopen`;
 * - anything the TypeScript parser recovers from but the runtime executes
 *   differently: start.ts is refused on any syntax diagnostic, but its
 *   imports are checked for resolution only, not for their own syntax.
 */
export function findRuntimeRoleGateProblem(
  startTs: string,
  files: Readonly<Record<string, string>> = {},
): string | null {
  const { program, unresolved } = startProgram(startTs, files);
  const checker = program.getTypeChecker();
  const start = program.getSourceFile(START)!;
  const [syntax] = program.getSyntacticDiagnostics(start);
  if (syntax) return unparsed(start, syntax);
  const nodes = descendants(start);

  const bypassIn = (file: ts.SourceFile) =>
    descendants(file)
      .map((node) => bypassToken(checker, node))
      .find((token) => token !== null);
  const bypass = bypassIn(start);
  if (bypass)
    return `start.ts bypasses the start-up gate with ${bypass}; start only through startProductionServer (ISSUE-193)`;
  for (const file of loadedModules(program)) {
    const token = bypassIn(file);
    if (token)
      return `start.ts loads ${relative(ROOT, file.fileName)}, which bypasses the start-up gate with ${token}; start only through startProductionServer (ISSUE-228)`;
  }
  const [missingImport] = unresolved;
  if (missingImport)
    return `start.ts imports ${missingImport}, which does not resolve; the gate cannot be checked (ISSUE-221)`;
  if (!importsStartUnaliased(start)) return IMPORT;
  const call = theStartCall(program, checker, start, nodes);
  if (typeof call === 'string') return call;
  return (
    refusalProblem(checker, call, nodes) ?? awaitProblem(checker, start, call)
  );
}

/** Refuses a start.ts that does not parse, naming TypeScript's first
 * syntax diagnostic: a recovered parse must never pass (ISSUE-221). */
const unparsed = (start: ts.SourceFile, diagnostic: ts.Diagnostic) =>
  `start.ts does not parse: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} (line ${
    start.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
  }); the gate cannot be checked (ISSUE-221)`;

type StartCall = ts.CallExpression & {
  readonly parent: ts.VariableDeclaration;
};

const descendants = (root: ts.Node): ts.Node[] => {
  const nodes: ts.Node[] = [];
  const collect = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, collect);
  };
  collect(root);
  return nodes;
};

/** The one `const { ... } = startProductionServer({ ... })` statement:
 * every identifier resolving to listen-first's export, through any alias
 * or re-export, must be that call's direct callee. */
const theStartCall = (
  program: ts.Program,
  checker: ts.TypeChecker,
  start: ts.SourceFile,
  nodes: readonly ts.Node[],
): StartCall | string => {
  const target = listenFirstExport(program, checker);
  const refersToTarget = (node: ts.Node): node is ts.Identifier =>
    ts.isIdentifier(node) &&
    !isImportBinding(node) &&
    target !== undefined &&
    resolved(checker, checker.getSymbolAtLocation(node)) === target;
  const references = nodes.filter(refersToTarget);
  const elsewhere = reachingModules(program)
    .filter((file) => file !== start)
    .some((file) => descendants(file).some(refersToTarget));
  if (references.length === 0 && !elsewhere) return MISSING;
  const [callee] = references;
  const call = callee?.parent;
  return !elsewhere &&
    call !== undefined &&
    references.length === 1 &&
    ts.isCallExpression(call) &&
    call.expression === callee &&
    call.questionDotToken === undefined &&
    isTopLevelDeclaration(start, call.parent)
    ? (call as StartCall)
    : ONE_CALL;
};

const isTopLevelDeclaration = (start: ts.SourceFile, node: ts.Node) =>
  ts.isVariableDeclaration(node) &&
  ts.isVariableDeclarationList(node.parent) &&
  ts.isVariableStatement(node.parent.parent) &&
  node.parent.parent.parent === start;

/** One object literal, refuseRole set once by a plain key to @offense-demo/db's
 * refuseSchemaAlteringRole, and nothing that could override it. */
const refusalProblem = (
  checker: ts.TypeChecker,
  call: StartCall,
  nodes: readonly ts.Node[],
): string | null => {
  const [options] = call.arguments;
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(options!))
    return MISSING;
  const properties = options.properties;
  const overridable = properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined && ts.isComputedPropertyName(property.name)),
  );
  const refusals = properties.filter(
    (property) => propertyName(property) === 'refuseRole',
  );
  if (overridable || refusals.length > 1) return OVERRIDDEN;
  const [refusal] = refusals;
  const refused = refusal && refusalCallee(refusal);
  if (!refused) return MISSING;
  const uses = nodes.filter(
    (node) =>
      ts.isIdentifier(node) &&
      !isImportBinding(node) &&
      isOffenseDemoDbRefusal(checker.getSymbolAtLocation(node)),
  );
  return uses.length === 1 && uses[0] === refused ? null : NOT_FROM_DB;
};

/** A top-level `await started;` on the call's own `started` binding. */
const awaitProblem = (
  checker: ts.TypeChecker,
  start: ts.SourceFile,
  call: StartCall,
): string | null => {
  const started = startedBinding(checker, call.parent);
  const awaited = start.statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isAwaitExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      started !== undefined &&
      checker.getSymbolAtLocation(statement.expression.expression) === started,
  );
  return awaited ? null : MISSING;
};

const ROOT = resolve('.');
const START = resolve('apps/web/src/server/start.ts');
const LISTEN_FIRST = resolve('apps/web/src/server/listen-first.ts');

const MISSING =
  "start.ts does not start through startProductionServer with refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web') and await started";
const IMPORT =
  'start.ts must import startProductionServer, unaliased, from ./listen-first and nothing else from it (ISSUE-218)';
const ONE_CALL =
  'start.ts must call startProductionServer exactly once, directly by that name; a second call, alias, .call, optional call or other reference starts a server the checked refusal does not guard (ISSUE-206, ISSUE-218)';
const OVERRIDDEN =
  "start.ts's startProductionServer call must set refuseRole once by a plain key, with no spread or computed key that could override it (ISSUE-206, ISSUE-218)";
const NOT_FROM_DB =
  'start.ts must import refuseSchemaAlteringRole from @offense-demo/db and use it only as the refuseRole (ISSUE-206)';

const moduleOf = (declaration: ts.ImportDeclaration) =>
  ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : '';

/** Exactly `import { startProductionServer } from './listen-first'`, and
 * no other import binds that name or reaches ./listen-first. */
const importsStartUnaliased = (start: ts.SourceFile) => {
  const imports = start.statements.filter(ts.isImportDeclaration);
  const fromListenFirst = imports.filter(
    (declaration) => moduleOf(declaration) === './listen-first',
  );
  const named = (declaration: ts.ImportDeclaration) => {
    const bindings = declaration.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
  };
  const [only] = fromListenFirst;
  const elements = only ? named(only) : [];
  const exact =
    fromListenFirst.length === 1 &&
    only!.importClause?.name === undefined &&
    elements.length === 1 &&
    elements[0]!.propertyName === undefined &&
    elements[0]!.name.text === 'startProductionServer';
  const elsewhere = imports
    .filter((declaration) => declaration !== only)
    .some((declaration) =>
      named(declaration).some(
        (element) =>
          (element.propertyName ?? element.name).text ===
            'startProductionServer' ||
          element.name.text === 'startProductionServer',
      ),
    );
  return exact && !elsewhere;
};

const isImportBinding = (node: ts.Identifier) =>
  ts.isImportSpecifier(node.parent) ||
  ts.isExportSpecifier(node.parent) ||
  ts.isImportClause(node.parent) ||
  ts.isNamespaceImport(node.parent);

/** The program's modules, other than listen-first.ts, that can reach its
 * export: any that names it or listen-first, and any that imports one of
 * those, to a fixpoint. Only these are searched for other references. */
const reachingModules = (program: ts.Program): ts.SourceFile[] => {
  const files = program
    .getSourceFiles()
    .filter((file) => file.fileName !== LISTEN_FIRST);
  const reaching = new Set(
    files.filter((file) =>
      /startProductionServer|listen-first/.test(file.text),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const file of files)
      if (
        !reaching.has(file) &&
        importedPaths(file).some((path) =>
          [...reaching].some((reached) => reached.fileName === path),
        )
      ) {
        reaching.add(file);
        grew = true;
      }
  }
  return [...reaching];
};

/** Every relative module in the program other than start.ts and the
 * modules listen-first.ts itself imports, which own the one listen and
 * prepare (ISSUE-228). */
const loadedModules = (program: ts.Program): ts.SourceFile[] => {
  const files = program.getSourceFiles();
  const gate = new Set<string>();
  const visit = (path: string) => {
    const file = files.find((candidate) => candidate.fileName === path);
    if (!file || gate.has(path)) return;
    gate.add(path);
    importedPaths(file).forEach(visit);
  };
  visit(LISTEN_FIRST);
  return files.filter(
    (file) => file.fileName !== START && !gate.has(file.fileName),
  );
};

const importedPaths = (file: ts.SourceFile): string[] =>
  file.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith('.')
      ? relativeCandidates(file.fileName, statement.moduleSpecifier.text)
      : [],
  );

const relativeCandidates = (containingFile: string, specifier: string) => {
  const base = resolve(dirname(containingFile), specifier);
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].filter(
    (path) => path.endsWith('.ts') || path.endsWith('.tsx'),
  );
};

const resolved = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined) =>
  symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;

/** listen-first.ts's own exported startProductionServer symbol. */
const listenFirstExport = (program: ts.Program, checker: ts.TypeChecker) => {
  const file = program.getSourceFile(LISTEN_FIRST);
  const module = file && checker.getSymbolAtLocation(file);
  const exported = module
    ? checker
        .getExportsOfModule(module)
        .find((symbol) => symbol.name === 'startProductionServer')
    : undefined;
  return resolved(checker, exported);
};

const propertyName = (property: ts.ObjectLiteralElementLike) =>
  property.name &&
  (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined;

/** The refuseSchemaAlteringRole identifier of
 * `refuseRole: () => refuseSchemaAlteringRole(app, 'offense_demo_web')`. */
const refusalCallee = (property: ts.ObjectLiteralElementLike) => {
  if (!ts.isPropertyAssignment(property)) return undefined;
  const arrow = property.initializer;
  if (!ts.isArrowFunction(arrow) || arrow.parameters.length > 0)
    return undefined;
  const body = arrow.body;
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression))
    return undefined;
  const [app, role] = body.arguments;
  return body.expression.text === 'refuseSchemaAlteringRole' &&
    body.arguments.length === 2 &&
    ts.isIdentifier(app!) &&
    app.text === 'app' &&
    ts.isStringLiteral(role!) &&
    role.text === 'offense_demo_web'
    ? body.expression
    : undefined;
};

/** The binding is @offense-demo/db's own export, imported under its own name. */
const isOffenseDemoDbRefusal = (symbol: ts.Symbol | undefined) => {
  const [declaration] = symbol?.declarations ?? [];
  if (!declaration || !ts.isImportSpecifier(declaration)) return false;
  const importDeclaration = declaration.parent.parent.parent;
  return (
    declaration.propertyName === undefined &&
    ts.isImportDeclaration(importDeclaration) &&
    moduleOf(importDeclaration) === '@offense-demo/db'
  );
};

/** The `started` binding in `const { server, started } = ...`. */
const startedBinding = (
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
) => {
  if (!ts.isObjectBindingPattern(declaration.name)) return undefined;
  const element = declaration.name.elements.find(
    (element) =>
      element.propertyName === undefined &&
      ts.isIdentifier(element.name) &&
      element.name.text === 'started',
  );
  return element ? checker.getSymbolAtLocation(element.name) : undefined;
};

const OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  noLib: true,
  types: [],
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};
const realSources = new Map<string, ts.SourceFile>();

/**
 * start.ts (as given) and listen-first.ts, with relative imports resolved
 * against the repository or `files` and package imports left out of the
 * program: only symbols reachable through relative modules matter here.
 * Every start.ts import must still resolve, a package one by TypeScript's
 * own module resolution, or the gate fails closed (ISSUE-221).
 */
const startProgram = (
  startTs: string,
  files: Readonly<Record<string, string>>,
) => {
  const overlay = new Map<string, string>([
    ...Object.entries(files).map(
      ([path, text]) => [resolve(path), text] as const,
    ),
    [START, startTs],
  ]);
  const read = (path: string) =>
    overlay.get(path) ??
    (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  const host = ts.createCompilerHost(OPTIONS, true);
  host.fileExists = (path) => read(path) !== undefined;
  host.readFile = read;
  host.getSourceFile = (path, languageVersion) => {
    const overlaid = overlay.get(path);
    if (overlaid !== undefined)
      return ts.createSourceFile(path, overlaid, languageVersion, true);
    const cached = realSources.get(path);
    if (cached) return cached;
    const text = read(path);
    if (text === undefined) return undefined;
    const source = ts.createSourceFile(path, text, languageVersion, true);
    realSources.set(path, source);
    return source;
  };
  const unresolved: string[] = [];
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      if (!literal.text.startsWith('.')) {
        if (
          containingFile === START &&
          !packageResolves(literal.text, containingFile)
        )
          unresolved.push(literal.text);
        return { resolvedModule: undefined };
      }
      const found = relativeCandidates(containingFile, literal.text).find(
        (path) => read(path) !== undefined,
      );
      if (!found && containingFile === START) unresolved.push(literal.text);
      return {
        resolvedModule: found
          ? {
              resolvedFileName: found,
              extension: found.endsWith('.tsx')
                ? ts.Extension.Tsx
                : ts.Extension.Ts,
              isExternalLibraryImport: false,
            }
          : undefined,
      };
    });
  const program = ts.createProgram({
    rootNames: [START, LISTEN_FIRST],
    options: OPTIONS,
    host,
  });
  program.getSourceFiles();
  return { program, unresolved };
};

const packageResolves = (specifier: string, containingFile: string) =>
  isBuiltin(specifier) ||
  ts.resolveModuleName(specifier, containingFile, RESOLUTION, ts.sys)
    .resolvedModule !== undefined;

const RESOLUTION: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

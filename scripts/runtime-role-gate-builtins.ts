import ts from 'typescript';

// Builtin loaders start.ts, and every module it loads, must never reach
// (scripts/runtime-role-gate.ts): Module's internals, resolved to the real
// `module` / `node:module` value binding rather than matched by name, so a
// local `_cache` or a type-only import passes (ISSUE-258, ISSUE-262);
// `vm` / `node:vm`; and Function reached through any `.constructor`
// (ISSUE-263).

/** Module's loader entry points: each loads, resolves, compiles or hooks
 * code. In Bun 1.4.2 `_load` returns undefined, but `_compile` runs source
 * and `prototype.require` loads; all are refused regardless. */
const MODULE_LOADERS = new Set([
  '_load',
  '_resolveFilename',
  '_compile',
  '_extensions',
  '_cache',
  '_pathCache',
  '_nodeModulePaths',
  '_findPath',
  '_initPaths',
  '_preloadModules',
  'wrap',
  'runMain',
  'register',
  'registerHooks',
  'Module',
]);

const NODE_MODULE = new Set(['module', 'node:module']);
const NODE_VM = new Set(['vm', 'node:vm']);
const NODE_PROCESS = new Set(['process', 'node:process']);

type Origin = { readonly module: string; readonly name: string };

/** The step this node takes toward a builtin loader, as the token it
 * reports, or null. */
export const builtinBypass = (
  checker: ts.TypeChecker,
  node: ts.Node,
): string | null => {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    return vmDeclaration(node) ? 'node:vm' : null;
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node))
    return specifierBypass(checker, node);
  const member = memberOf(node);
  if (!member) return null;
  if (member.name === 'constructor')
    return constructorBypass(checker, node) ? '.constructor' : null;
  if (member.name === 'getBuiltinModule') return 'process.getBuiltinModule';
  return MODULE_LOADERS.has(member.name) &&
    member.owner !== undefined &&
    resolvesToNodeModule(checker, member.owner, 0)
    ? `node:module.${member.name}`
    : null;
};

/** A non-type-only import or re-export of `vm` / `node:vm`, including a
 * bare side-effect import. */
const vmDeclaration = (node: ts.ImportDeclaration | ts.ExportDeclaration) => {
  const module = moduleText(node);
  if (module === undefined || !NODE_VM.has(module)) return false;
  if (ts.isExportDeclaration(node))
    return !node.isTypeOnly && !allTypeOnly(node.exportClause);
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  return clause.name !== undefined || !allTypeOnly(clause.namedBindings);
};

const allTypeOnly = (
  bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined,
) =>
  bindings !== undefined &&
  (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
  bindings.elements.every((element) => element.isTypeOnly);

/** An imported or re-exported name whose alias chain ends at a Module
 * loader, `vm`, or process's getBuiltinModule. */
const specifierBypass = (
  checker: ts.TypeChecker,
  node: ts.ImportSpecifier | ts.ExportSpecifier,
): string | null => {
  const own = bindingSource(node);
  if (own?.typeOnly) return null;
  if (own && NODE_PROCESS.has(own.module) && own.name === 'getBuiltinModule')
    return 'process.getBuiltinModule';
  const origin = builtinOrigin(checker, checker.getSymbolAtLocation(node.name));
  if (!origin) return null;
  if (NODE_VM.has(origin.module)) return 'node:vm';
  return MODULE_LOADERS.has(origin.name) ? `node:module.${origin.name}` : null;
};

/** Where a binding comes from: its module, the name it has there, and
 * whether it is type-only. */
const bindingSource = (
  declaration: ts.Declaration,
): (Origin & { readonly typeOnly: boolean }) | undefined => {
  if (ts.isImportSpecifier(declaration)) {
    const importDeclaration = declaration.parent.parent.parent;
    const module = moduleText(importDeclaration);
    return module === undefined
      ? undefined
      : {
          module,
          name: (declaration.propertyName ?? declaration.name).text,
          typeOnly:
            declaration.isTypeOnly || declaration.parent.parent.isTypeOnly,
        };
  }
  if (ts.isExportSpecifier(declaration)) {
    const exportDeclaration = declaration.parent.parent;
    const module = moduleText(exportDeclaration);
    return module === undefined
      ? undefined
      : {
          module,
          name: (declaration.propertyName ?? declaration.name).text,
          typeOnly: declaration.isTypeOnly || exportDeclaration.isTypeOnly,
        };
  }
  const clause = ts.isImportClause(declaration)
    ? declaration
    : ts.isNamespaceImport(declaration)
      ? declaration.parent
      : undefined;
  const module = clause && moduleText(clause.parent);
  return clause && module !== undefined
    ? {
        module,
        name: ts.isImportClause(declaration) ? 'default' : '*',
        typeOnly: clause.isTypeOnly,
      }
    : undefined;
};

const moduleText = (node: ts.ImportDeclaration | ts.ExportDeclaration) =>
  node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;

/** Follows a symbol's alias chain (imports, re-exports, shims) to a real,
 * value-level `module` or `vm` binding. */
const builtinOrigin = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): Origin | undefined => {
  let at = symbol;
  for (let hop = 0; at && hop < 16; hop++) {
    for (const declaration of at.declarations ?? []) {
      const source = bindingSource(declaration);
      if (
        source &&
        !source.typeOnly &&
        (NODE_MODULE.has(source.module) || NODE_VM.has(source.module))
      )
        return source;
    }
    at =
      at.flags & ts.SymbolFlags.Alias
        ? checker.getImmediateAliasedSymbol(at)
        : undefined;
  }
  return undefined;
};

/** Whether an owner expression is the real Module: the `module` binding
 * itself, a const alias or destructured name of it, a member of it
 * (`nm.Module`, `Module.prototype`), an instance (`new Module(...)`), or a
 * `getBuiltinModule` result. */
const resolvesToNodeModule = (
  checker: ts.TypeChecker,
  expression: ts.Expression,
  depth: number,
): boolean => {
  if (depth > 16) return false;
  const next = (inner: ts.Expression) =>
    resolvesToNodeModule(checker, inner, depth + 1);
  const node = ts.skipOuterExpressions(expression);
  const operands = yieldedOperands(node);
  if (operands) return operands.some(next);
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    const origin = builtinOrigin(checker, symbol);
    if (origin) return NODE_MODULE.has(origin.module);
    const initializer = boundInitializer(symbol);
    return initializer !== undefined && next(initializer);
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isNewExpression(node)
  )
    return next(node.expression);
  return (
    ts.isCallExpression(node) &&
    memberOf(node.expression)?.name === 'getBuiltinModule'
  );
};

/** The operands whose value an expression can yield: the right side of a
 * comma, both branches of a conditional, both sides of `&&`, `||` and
 * `??` (ISSUE-267). Undefined for any other expression. */
const yieldedOperands = (
  node: ts.Node,
): readonly ts.Expression[] | undefined => {
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  if (!ts.isBinaryExpression(node)) return undefined;
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken) return [node.right];
  return operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken
    ? [node.left, node.right]
    : undefined;
};

/** The outermost expression that still yields `node`'s value, through
 * parentheses, type assertions, `!` and yielded operands. */
const yieldingParent = (node: ts.Node): ts.Node => {
  let at = node;
  for (;;) {
    const parent = at.parent;
    const wraps =
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      (yieldedOperands(parent)?.includes(at as ts.Expression) ?? false);
    if (!wraps) return at;
    at = parent;
  }
};

/** Whether this expression's value is called or passed to `new`. */
const isInvoked = (node: ts.Node) => {
  const top = yieldingParent(node);
  const parent = top.parent;
  return (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === top
  );
};

/** A `.constructor` value reaches Function only when it is invoked:
 * called or new'd directly, or through a variable that is invoked later
 * in the same file. A destructured `constructor` key is always refused. A
 * read that is never invoked (`err.constructor.name`,
 * `v.constructor === Object`, `this.constructor`) passes (ISSUE-266). */
const constructorBypass = (checker: ts.TypeChecker, node: ts.Node) => {
  if (ts.isBindingElement(node)) return true;
  if (isInvoked(node)) return true;
  const top = yieldingParent(node);
  const declaration = top.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== top ||
    !ts.isIdentifier(declaration.name)
  )
    return false;
  const bound = checker.getSymbolAtLocation(declaration.name);
  const uses: ts.Node[] = [];
  const collect = (at: ts.Node) => {
    if (
      ts.isIdentifier(at) &&
      at !== declaration.name &&
      checker.getSymbolAtLocation(at) === bound
    )
      uses.push(at);
    ts.forEachChild(at, collect);
  };
  collect(node.getSourceFile());
  return uses.some(isInvoked);
};

/** The expression a `const x = …` or `const { x } = …` binding is read
 * from, so an alias of Module resolves to Module. */
const boundInitializer = (symbol: ts.Symbol | undefined) => {
  const [declaration] = symbol?.declarations ?? [];
  if (declaration && ts.isVariableDeclaration(declaration))
    return declaration.initializer;
  return declaration &&
    ts.isBindingElement(declaration) &&
    ts.isVariableDeclaration(declaration.parent.parent)
    ? declaration.parent.parent.initializer
    : undefined;
};

/** The member a `.name`, `['name']` or `{ name }` destructuring touches,
 * and the expression it is read off. */
const memberOf = (
  node: ts.Node,
): { readonly name: string; readonly owner?: ts.Expression } | undefined => {
  if (ts.isPropertyAccessExpression(node))
    return { name: node.name.text, owner: node.expression };
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return { name: node.argumentExpression.text, owner: node.expression };
  if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent))
    return undefined;
  const key = node.propertyName ?? node.name;
  const declaration = node.parent.parent;
  return ts.isIdentifier(key) || ts.isStringLiteral(key)
    ? {
        name: key.text,
        owner: ts.isVariableDeclaration(declaration)
          ? declaration.initializer
          : undefined,
      }
    : undefined;
};

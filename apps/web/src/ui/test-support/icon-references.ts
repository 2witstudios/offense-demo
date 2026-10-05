/**
 * Test support: finds the icon names a source file passes as string literals.
 *
 * Covered statically:
 * - the name prop of Icon / IconButton, attributed by the nearest preceding
 *   opening tag, so an arrow function's `>` earlier in the tag is fine and
 *   the name prop of other elements (Avatar, inputs) is ignored;
 * - any JSX prop called icon or glyph (Panel, Stat, NavItem, ActionTile);
 * - object data keyed icon or glyph (sidebar navigation, tiles);
 * - double-quoted, single-quoted, and plain template literals, directly or
 *   anywhere inside a braced expression, so both arms of a ternary count.
 *
 * Not covered, by design: names that reach the prop through a variable,
 * import, function call, or destructuring default; template literals with
 * substitutions; JSX props written with spaces around `=` (Prettier never
 * emits them); and a name prop that follows a nested JSX element or a
 * generic type argument inside an earlier prop of the same tag (that `<X` is
 * then taken as the owner, so the name is skipped).
 * Data-driven names are also checked by importing the data (icons.test.tsx).
 */
const iconProps = /\b(name|icon|glyph)(=|\s*:\s*)/g;
const stringLiterals = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`/g;
const nameOwners = new Set(['Icon', 'IconButton']);

const literalsIn = (expression: string): readonly string[] =>
  [...expression.matchAll(stringLiterals)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );

const enclosingTag = (source: string, index: number): string | undefined =>
  [...source.slice(0, index).matchAll(/<([A-Za-z]\w*)/g)].at(-1)?.[1];

/** The braced expression starting at `start`, braces balanced. */
const bracedExpression = (source: string, start: number): string => {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
};

const jsxValue = (source: string, start: number): string => {
  const first = source[start] ?? '';
  if (first === '{') return bracedExpression(source, start);
  if (!/['"`]/.test(first)) return '';
  const end = source.indexOf(first, start + 1);
  return end === -1 ? '' : source.slice(start, end + 1);
};

/** Object data: the value runs to the end of the property. */
const dataValue = (source: string, start: number): string =>
  /^[^,;}]*/.exec(source.slice(start))?.[0] ?? '';

export const extractIconNames = (source: string): readonly string[] =>
  [...source.matchAll(iconProps)].flatMap((match) => {
    const [whole, prop = '', operator = ''] = match;
    const isJsxProp = operator === '=';
    if (prop === 'name') {
      if (!isJsxProp) return [];
      if (!nameOwners.has(enclosingTag(source, match.index) ?? '')) return [];
    }
    const start = match.index + whole.length;
    return literalsIn(
      isJsxProp ? jsxValue(source, start) : dataValue(source, start),
    );
  });

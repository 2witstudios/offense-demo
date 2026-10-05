import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

/** The real theme stylesheet, parsed rather than pattern-matched. */
const stylesheet = postcss.parse(
  readFileSync(join(import.meta.dir, '../../app/globals.css'), 'utf8'),
);

/** Each rule's declarations, name → value, for the selectors that match. */
export const declarationsOf = (
  matches: (selector: string) => boolean,
): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  stylesheet.walkRules((rule) => {
    if (rule.selectors.some(matches))
      rule.each((node) => {
        if (node.type === 'decl') found.set(node.prop, node.value);
      });
  });
  return found;
};

/** Every custom property declared in any `:root…` rule, name → value. */
export const rootTokens = (): ReadonlyMap<string, string> =>
  new Map(
    [...declarationsOf((selector) => selector.startsWith(':root'))].filter(
      ([name]) => name.startsWith('--'),
    ),
  );

export type Scheme = 'light' | 'dark';

/**
 * One scheme's side of a `light-dark(<light>, <dark>)` value, split at its
 * top-level comma so `rgba(…)` arguments stay whole.
 */
export const schemeValue = (value: string, scheme: Scheme): string => {
  const inner = /^light-dark\((.*)\)$/s.exec(value.trim())?.[1];
  if (inner === undefined) throw new Error(`not a light-dark() pair: ${value}`);
  let depth = 0;
  const comma = [...inner].findIndex((char) => {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    return char === ',' && depth === 0;
  });
  const side =
    scheme === 'light' ? inner.slice(0, comma) : inner.slice(comma + 1);
  return side.trim();
};

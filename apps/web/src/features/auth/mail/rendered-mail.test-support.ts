/**
 * Reads a rendered auth email the way a mail client does: its body elements
 * with their classes, inline styles and text, and the rules of its
 * `prefers-color-scheme: dark` block. Shared by the layout and per-kind
 * template tests so both judge the emailed markup, not a copy of the palette.
 */
export type MailElement = {
  readonly tag: string;
  readonly classes: readonly string[];
  readonly style: Readonly<Record<string, string>>;
  readonly parent: MailElement | null;
  text: string;
};

const VOID_TAGS = new Set(['meta', 'br', 'img', 'hr', 'link', '!doctype']);

const declarationsOf = (declarations: string) =>
  declarations
    .split(';')
    .map((declaration) => declaration.split(/:(.*)/s, 2))
    .filter((pair): pair is [string, string] => pair.length === 2)
    .map(([property, value]) => ({
      property: property.trim(),
      value: value.replace('!important', '').trim(),
      important: value.includes('!important'),
    }));

const parseStyle = (declarations: string): Record<string, string> =>
  Object.fromEntries(
    declarationsOf(declarations).map(({ property, value }) => [
      property,
      value,
    ]),
  );

const attribute = (attributes: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1];

const elementFrom = (
  tag: string,
  attributes: string,
  parent: MailElement | undefined,
  text: string,
): MailElement => ({
  tag,
  classes: attribute(attributes, 'class')?.split(/\s+/) ?? [],
  style: parseStyle(attribute(attributes, 'style') ?? ''),
  parent: parent ?? null,
  text,
});

/**
 * The rendered body's elements, each with its classes, inline style, parent
 * and own text, walked from the real markup a mail client receives: the
 * colors under test are the emailed ones, not a copy of the palette.
 */
export function parseElements(html: string): MailElement[] {
  const body = html.slice(html.indexOf('<body'));
  const elements: MailElement[] = [];
  const stack: MailElement[] = [];
  const token = /<(\/?)([a-z0-9!]+)([^>]*)>([^<]*)/gi;
  for (const [, closing, rawTag, attributes, text] of body.matchAll(token)) {
    const tag = rawTag!.toLowerCase();
    if (closing) {
      stack.pop();
      const parent = stack.at(-1);
      if (parent) parent.text += text!;
      continue;
    }
    const element = elementFrom(tag, attributes!, stack.at(-1), text!);
    elements.push(element);
    if (!VOID_TAGS.has(tag)) stack.push(element);
  }
  return elements;
}

export type DarkRule = {
  readonly selector: readonly string[];
  readonly style: Readonly<Record<string, string>>;
  /** Properties declared `!important`: only these beat an inline style. */
  readonly important: ReadonlySet<string>;
};

/** The `prefers-color-scheme: dark` block's rules, in source order. */
export function parseDarkRules(html: string): DarkRule[] {
  const block =
    /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\s*\}\n/.exec(
      html,
    )?.[1] ?? '';
  return [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
    ([, selector, declarations]) => ({
      selector: selector!.trim().split(/\s+/),
      style: parseStyle(declarations!),
      important: new Set(
        declarationsOf(declarations!)
          .filter(({ important }) => important)
          .map(({ property }) => property),
      ),
    }),
  );
}

const matchesPart = (element: MailElement, part: string) =>
  part.startsWith('.')
    ? element.classes.includes(part.slice(1))
    : element.tag === part;

/** A descendant-combinator selector (`.a p`) matched right to left. */
function matchesSelector(element: MailElement, selector: readonly string[]) {
  if (!matchesPart(element, selector.at(-1)!)) return false;
  let rest = selector.slice(0, -1);
  for (let node = element.parent; node && rest.length; node = node.parent)
    if (matchesPart(node, rest.at(-1)!)) rest = rest.slice(0, -1);
  return rest.length === 0;
}

export type Theme = 'light' | 'dark';

/**
 * Whether a dark rule sets this property on the element in a dark client:
 * it must match the element, and where the element also sets the property
 * inline it must be `!important`, since an inline style otherwise wins.
 */
const darkRuleApplies = (
  rule: DarkRule,
  element: MailElement,
  property: string,
) =>
  rule.style[property] !== undefined &&
  matchesSelector(element, rule.selector) &&
  (element.style[property] === undefined || rule.important.has(property));

/**
 * The element's own declared value for a property: in dark mode a matching
 * media rule that applies (`darkRuleApplies`) wins, else its inline style.
 * An inherited dark color never beats an element's own inline color.
 */
function ownValue(
  element: MailElement,
  property: string,
  theme: Theme,
  rules: readonly DarkRule[],
): string | undefined {
  const dark =
    theme === 'dark'
      ? rules.filter((rule) => darkRuleApplies(rule, element, property)).at(-1)
          ?.style[property]
      : undefined;
  return dark ?? element.style[property];
}

/** Color inherits; the backdrop is the nearest painted ancestor. */
export function resolved(
  element: MailElement,
  property: 'color' | 'background',
  theme: Theme,
  rules: readonly DarkRule[],
): string | undefined {
  for (let node: MailElement | null = element; node; node = node.parent) {
    const value = ownValue(node, property, theme, rules);
    if (value) return value;
  }
  return undefined;
}

const INLINE_COLOURS = ['background', 'color'] as const;

/**
 * Each element that sets a colour inline with no `!important` dark-block
 * rule overriding that same property on it: a light value that would
 * survive into a dark client (ISSUE-167). Named `<tag class> property` so a
 * failure is findable.
 */
export function inlineColoursWithoutDarkOverride(html: string): string[] {
  const rules = parseDarkRules(html);
  return parseElements(html).flatMap((element) =>
    INLINE_COLOURS.filter(
      (property) =>
        element.style[property] !== undefined &&
        !rules.some((rule) => darkRuleApplies(rule, element, property)),
    ).map(
      (property) =>
        `<${element.tag}${element.classes.length ? ` class="${element.classes.join(' ')}"` : ''}> ${property}`,
    ),
  );
}

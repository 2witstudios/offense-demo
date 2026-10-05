import { isValidElement, type ReactElement, type ReactNode } from 'react';

type Props = Readonly<Record<string, unknown>>;

const childNodes = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value.flatMap(childNodes) : [value];

/**
 * Test support: every element in an unrendered tree that matches, searching
 * children and element-valued props (an input's `action` slot, a frame's
 * `panel.body`) without calling any component.
 */
export const findElements = (
  node: ReactNode | unknown,
  matches: (element: ReactElement<Props>) => boolean,
): readonly ReactElement<Props>[] => {
  if (Array.isArray(node))
    return node.flatMap((child) => findElements(child, matches));
  if (!isValidElement<Props>(node)) {
    if (node !== null && typeof node === 'object' && !(node instanceof Date))
      return Object.values(node).flatMap((value) =>
        findElements(value, matches),
      );
    return [];
  }
  const nested = Object.values(node.props).flatMap((value) =>
    childNodes(value).flatMap((child) => findElements(child, matches)),
  );
  return matches(node) ? [node, ...nested] : nested;
};

/** Flattens an element's text children, deeply, for matching by label. */
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<Props>(node)) return textOf(node.props['children']);
  return '';
};

/** The first element whose text includes the label. */
export const byText = (
  node: ReactNode,
  type: unknown,
  label: string,
): ReactElement<Props> | undefined =>
  findElements(
    node,
    (element) => element.type === type && textOf(element).includes(label),
  )[0];

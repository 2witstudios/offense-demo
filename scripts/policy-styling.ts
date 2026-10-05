// Token-locked styling rules for the policy scanner (ADR 0028).

export type StylingRule = 'inline-style' | 'tailwind-lint-disable';

export const stylingRules: Readonly<Record<StylingRule, RegExp>> = {
  // Tailwind ships as a build-time stylesheet only: the nonce CSP forbids
  // inline style attributes and runtime style elements.
  'inline-style': /\bstyle=[{"']|<style[\s>]/,
  // A silenced Tailwind rule is a token-lock exception and needs a registry
  // entry with an ADR, like every other exception.
  'tailwind-lint-disable': /eslint-disable[^\n]*better-tailwindcss/,
};

const shippedTsx = /(?<!\.test)\.tsx$/;

/** Inline styles are a markup concern: only shipped TSX is scanned for them. */
export const stylingRuleApplies = (rule: string, path: string): boolean =>
  rule !== 'inline-style' || shippedTsx.test(path);

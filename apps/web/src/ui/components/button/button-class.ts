export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

// Variants never override the base: each owns its padding, so no two classes
// on one element ever set the same property.
const base =
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-sm border text-base leading-tight font-strong transition-colors duration-120 ease-standard disabled:cursor-not-allowed disabled:opacity-60';

const variants: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'border-transparent bg-accent px-5 py-3 text-accent-ink hover:bg-accent-strong',
  secondary:
    'border-border-strong bg-transparent px-5 py-3 text-ink hover:border-ink-muted hover:text-ink',
  ghost:
    'border-transparent bg-transparent px-3 py-2 text-ink-muted hover:text-ink',
};

/** Classes for a button of the given variant. */
export const buttonClass = (variant: ButtonVariant): string =>
  `${base} ${variants[variant]}`;

/** Classes shared by every auth text field: label, input row and input. */
export const fieldClass = {
  label: 'text-sm font-semibold',
  row: 'flex gap-3 max-narrow:flex-col',
  input:
    'h-auth-control min-w-0 grow rounded-md border border-border-strong bg-surface-raised px-4 text-md text-ink placeholder:text-ink-faint disabled:opacity-60 aria-invalid:border-live',
} as const;

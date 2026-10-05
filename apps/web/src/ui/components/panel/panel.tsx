import type { ReactNode } from 'react';

export type PanelProps = {
  /** Short label, set as a quiet uppercase eyebrow above the content. */
  readonly title: ReactNode;
  /** Trailing header action, e.g. a "See all" ghost button. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
};

/** A card separated from the page by tone, not a border. */
export function Panel({ title, action, children }: PanelProps) {
  return (
    <section className="rounded-xl bg-surface p-6 shadow-1">
      <header className="mb-5 flex min-h-10 items-center gap-2">
        <h2 className="text-xs font-bold tracking-widest text-ink-muted uppercase">
          {title}
        </h2>
        {action ? <div className="-mr-3 ml-auto">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

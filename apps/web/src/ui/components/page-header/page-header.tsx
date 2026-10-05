import type { ReactNode } from 'react';

/** A page title with an optional lede and trailing actions. */
export function PageHeader({
  title,
  lede,
  actions,
}: {
  readonly title: ReactNode;
  readonly lede?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-3xl leading-tight font-bold tracking-tight max-compact:text-2xl">
          {title}
        </h1>
        {lede ? <p className="text-base text-ink-muted">{lede}</p> : null}
      </div>
      {actions ? <div className="flex gap-3">{actions}</div> : null}
    </header>
  );
}

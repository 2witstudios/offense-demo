import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClass } from '../button/button-class';
import { Icon } from '../icon/icon';

/** "Clear" inside a filter panel: a link to the URL without the filters. */
export function ClearFilters({ href }: { readonly href: string | null }) {
  if (href === null) return null;
  return (
    <Link
      href={href}
      className="order-9 flex min-h-10 items-center px-1 text-base font-strong max-compact:order-none"
    >
      Clear
    </Link>
  );
}

/**
 * The tail of a GET filter form: the result count (phone only), any extra
 * control such as a sort, and the Apply button that works without script.
 */
export function FilterFooter({
  count,
  noun,
  children,
}: {
  readonly count: number;
  /** Singular: "room" reads "1 room", "8 rooms". */
  readonly noun: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="order-7 contents max-compact:order-5 max-compact:flex max-compact:basis-full max-compact:items-center max-compact:justify-between">
      <p className="hidden text-sm whitespace-nowrap text-ink-muted max-compact:block">
        {`${count} ${count === 1 ? noun : `${noun}s`}`}
      </p>
      {children}
      <button type="submit" className={`${buttonClass('secondary')} order-8`}>
        Apply
      </button>
    </div>
  );
}

/** The control look shared by the search box and every select. */
const controlClass =
  'h-10 min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base text-ink max-compact:h-12';

/** A named select whose chosen value rides in the URL. */
export function FilterSelect(props: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly className?: string;
}) {
  return (
    <select
      name={props.name}
      aria-label={props.label}
      defaultValue={props.value}
      className={`${controlClass} ${props.className ?? ''}`.trim()}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** The `q` search field of a filter form. */
export function SearchField(props: {
  readonly defaultValue: string;
  readonly maxLength: number;
  readonly placeholder: string;
  readonly label: string;
}) {
  return (
    <label
      className={`${controlClass} order-4 flex grow basis-1/6 items-center gap-2 text-ink-muted max-compact:order-3`}
    >
      <Icon name="search" size={16} />
      <input
        type="search"
        name="q"
        defaultValue={props.defaultValue}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        aria-label={props.label}
        className="min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-faint"
      />
    </label>
  );
}

/** The phone "Filters" summary with a count of the filters set. */
export function FiltersLabel({ active }: { readonly active: number }) {
  return (
    <>
      <Icon name="dots" size={18} />
      Filters
      {active > 0 ? (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-round bg-accent px-2 text-xs font-bold text-accent-ink">
          {active}
        </span>
      ) : null}
    </>
  );
}

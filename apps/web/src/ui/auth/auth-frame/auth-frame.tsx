import Link from 'next/link';
import type { ReactNode } from 'react';
import { appConfig } from '../../../app-config';
import {
  BrandMark,
  BrandWordmark,
} from '../../components/brand-mark/brand-mark';

export type AuthPanelCopy = {
  readonly eyebrow: string;
  readonly title: string;
  readonly body?: ReactNode;
};

export type AuthFrameProps = {
  /** Explains the step. It never holds a control: people act on the left. */
  readonly panel: AuthPanelCopy;
  /** A reassurance line under the step; omit when the step needs none. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
};

/** Page frame shared by every sign-in step. */
export function AuthFrame({ panel, footer, children }: AuthFrameProps) {
  return (
    <div className="flex min-h-dvh gap-6 bg-background p-6 text-ink max-narrow:p-4">
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-12 px-16 pt-4 pb-8 max-reflow:px-8 max-narrow:px-0">
        <Link
          href="/"
          className="flex items-center gap-2 self-start text-ink no-underline hover:no-underline"
        >
          <BrandWordmark />
        </Link>
        <div className="flex max-w-auth-copy flex-col gap-8">{children}</div>
        {/* The slot stays when empty so the step keeps its vertical place. */}
        <div className="text-sm text-ink-muted">{footer}</div>
      </div>
      <aside className="relative isolate flex w-auth-panel shrink-0 flex-col justify-end gap-4 overflow-hidden rounded-xl bg-surface-stage p-10 text-stage-ink max-rail:hidden">
        <BrandMark
          size={520}
          variant="reverse"
          className="absolute -top-auth-mark-top -right-auth-mark-right -z-1 size-auth-mark opacity-20"
        />
        <p className="text-xs font-bold tracking-widest text-stage-ink-muted uppercase">
          {panel.eyebrow}
        </p>
        <p className="font-display text-3xl leading-tight font-semibold tracking-tighter text-balance">
          {panel.title}
        </p>
        {panel.body === undefined ? null : (
          <div className="text-md text-stage-ink-muted">{panel.body}</div>
        )}
      </aside>
    </div>
  );
}

export type AuthHeadingProps = {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
  /** Quiet eyebrow for steps that report a dead end rather than progress. */
  readonly muted?: boolean;
  /** Makes the headline a focus target, for a step an answer leads to. */
  readonly id?: string;
};

/** Eyebrow, display headline and lede at the top of a step. */
export function AuthHeading({
  eyebrow,
  title,
  children,
  muted = false,
  id,
}: AuthHeadingProps) {
  return (
    <div className="flex flex-col gap-4">
      <p
        className={
          muted
            ? 'text-xs font-bold tracking-widest text-ink-muted uppercase'
            : 'text-xs font-bold tracking-widest text-accent-strong uppercase'
        }
      >
        {eyebrow}
      </p>
      <h1
        id={id}
        tabIndex={id === undefined ? undefined : -1}
        className="font-display text-display leading-display font-semibold tracking-display text-balance max-narrow:text-3xl"
      >
        {title}
      </h1>
      <p className="text-lg text-ink-muted">{children}</p>
    </div>
  );
}

/** Brand panel for steps whose left column needs no explanation. */
export const taglinePanel: AuthPanelCopy = {
  eyebrow: appConfig.brand.displayName,
  title: appConfig.brand.tagline,
};

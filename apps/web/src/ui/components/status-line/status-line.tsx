import type { ReactNode } from 'react';
import {
  statusDotClass,
  statusLineClass,
  type StatusTone,
} from './status-line-class';

export type StatusLineProps = {
  readonly tone?: StatusTone;
  readonly children: ReactNode;
};

export function StatusLine({ tone = 'neutral', children }: StatusLineProps) {
  return (
    <span className={statusLineClass}>
      <span className={statusDotClass(tone)} aria-hidden="true" />
      {children}
    </span>
  );
}

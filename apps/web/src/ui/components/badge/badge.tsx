import type { ReactNode } from 'react';
import { badgeClass, type BadgeTone } from './badge-class';

export type BadgeProps = {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
};

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span className={badgeClass(tone)}>{children}</span>;
}

import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon';

export type StatProps = {
  readonly value: ReactNode;
  readonly icon?: IconName;
  readonly label?: string;
};

export function Stat({ value, icon, label }: StatProps) {
  return (
    <span
      className={
        'inline-flex items-baseline gap-1 text-sm whitespace-nowrap text-ink-muted tabular-nums'
      }
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <span className={'font-strong text-ink'}>{value}</span>
      {label ? <span className={'text-xs text-ink-faint'}>{label}</span> : null}
    </span>
  );
}

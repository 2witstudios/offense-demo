import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/icon/icon';
import { noticeClass, noticeIconClass, type NoticeTone } from './notice-class';
import type { NoticeCopy } from '../sign-in-notices';

/** The icon that leads a notice: a warning for errors, a clock otherwise. */
export const noticeIcon: Readonly<Record<NoticeTone, IconName>> = {
  error: 'alert',
  info: 'clock',
};

export type NoticeProps = {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly title: string;
  readonly children?: ReactNode;
};

/**
 * A message beside the control it is about. Errors interrupt (role=alert);
 * information waits its turn (role=status). Colour is never the only signal.
 */
export function Notice({ id, tone, title, children }: NoticeProps) {
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      className={noticeClass(tone)}
    >
      <Icon
        name={noticeIcon[tone]}
        size={20}
        className={noticeIconClass(tone)}
      />
      <p>
        <strong className="font-semibold">{title}</strong>
        {children === undefined ? null : <> {children}</>}
      </p>
    </div>
  );
}

/** A written notice from a copy table, or nothing when there is none. */
export function CopyNotice({
  id,
  copy,
}: {
  readonly id: string;
  readonly copy: NoticeCopy | undefined;
}) {
  return copy === undefined ? null : (
    <Notice id={id} tone={copy.tone} title={copy.title}>
      {copy.body}
    </Notice>
  );
}

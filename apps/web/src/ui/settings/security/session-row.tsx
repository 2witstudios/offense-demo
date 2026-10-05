'use client';

import { useState } from 'react';
import {
  revokeSession,
  type SessionRow,
} from '../../../features/account/security-client';
import { Button } from '../../components/button/button';
import { Notice } from '../../auth/notice/notice';
import { OUTCOME_NOTICES, formatDate } from './security-notices';

export function SessionRowView({
  session,
  onRevoked,
}: {
  readonly session: SessionRow;
  readonly onRevoked: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const revoke = async () => {
    setPending(true);
    setNotice(undefined);
    const outcome = await revokeSession(session.id);
    setPending(false);
    if (outcome.kind === 'ok') onRevoked(session.id);
    else setNotice(OUTCOME_NOTICES[outcome.kind]);
  };

  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-none">
      <div className="flex flex-wrap items-center gap-3">
        <span>{session.userAgent ?? 'Unknown device'}</span>
        <span className="text-sm text-ink-muted">
          Active since {formatDate(session.createdAt)}
        </span>
        {session.current ? (
          <span className="text-sm font-semibold text-accent">This device</span>
        ) : (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => void revoke()}
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </Button>
        )}
      </div>
      {notice ? (
        <Notice
          id={`session-notice-${session.id}`}
          tone="error"
          title={notice}
        />
      ) : null}
    </li>
  );
}

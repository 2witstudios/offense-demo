'use client';

import { useState } from 'react';
import { authClient } from '../../../lib/auth-client';
import {
  removePasskey,
  renamePasskey,
  type PasskeyRow,
} from '../../../features/account/security-client';
import { Button } from '../../components/button/button';
import { Notice } from '../../auth/notice/notice';
import { OUTCOME_NOTICES, formatDate } from './security-notices';

export function PasskeyRowView({
  passkey,
  onRenamed,
  onRemoved,
}: {
  readonly passkey: PasskeyRow;
  readonly onRenamed: (id: string, name: string) => void;
  readonly onRemoved: (id: string) => void;
}) {
  const [name, setName] = useState(passkey.name ?? '');
  const [pending, setPending] = useState<'rename' | 'remove' | 'none'>('none');
  const [notice, setNotice] = useState<string | undefined>();

  const rename = async () => {
    setPending('rename');
    setNotice(undefined);
    const outcome = await renamePasskey(authClient, passkey.id, name.trim());
    setPending('none');
    if (outcome.kind === 'ok') onRenamed(passkey.id, name.trim());
    else setNotice(OUTCOME_NOTICES[outcome.kind]);
  };

  const remove = async () => {
    setPending('remove');
    setNotice(undefined);
    const outcome = await removePasskey(authClient, passkey.id);
    setPending('none');
    if (outcome.kind === 'ok') onRemoved(passkey.id);
    else setNotice(OUTCOME_NOTICES[outcome.kind]);
  };

  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-none">
      <div className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor={`passkey-name-${passkey.id}`}>
          Passkey name
        </label>
        <input
          id={`passkey-name-${passkey.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={pending !== 'none'}
          className="rounded-md border border-border bg-surface px-2 py-1"
        />
        <span className="text-sm text-ink-muted">
          Added {formatDate(passkey.createdAt)}
        </span>
        <Button
          variant="secondary"
          disabled={pending !== 'none' || name.trim() === (passkey.name ?? '')}
          onClick={() => void rename()}
        >
          {pending === 'rename' ? 'Saving…' : 'Rename'}
        </Button>
        <Button
          variant="ghost"
          disabled={pending !== 'none'}
          onClick={() => void remove()}
        >
          {pending === 'remove' ? 'Removing…' : 'Remove'}
        </Button>
      </div>
      {notice ? (
        <Notice
          id={`passkey-notice-${passkey.id}`}
          tone="error"
          title={notice}
        />
      ) : null}
    </li>
  );
}

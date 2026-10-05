'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormAction } from '../../form-action/form-action';
import {
  claimUnavailable,
  initialUsernameForm,
  refusesShape,
  shownNotice,
  type LocalNotice,
  type UsernameFormState,
} from './claim-form';
import { UsernameForm } from './username-form';

/** The username claim: a server action bound to the validated destination. */
export type ClaimAction = (
  state: UsernameFormState,
  form: FormData,
) => Promise<UsernameFormState>;

/**
 * Username onboarding. The form posts to `claim`, a server action, so a
 * submission before hydration or without JavaScript is the same POST; the
 * action moves a claimed account on to the passkey offer, by a 303 without
 * JavaScript and by answering `next` for this page to navigate to with it.
 * JavaScript only adds the local shape check and the pending state.
 */
export function Onboarding({
  claim,
  signInHref,
}: {
  readonly claim: ClaimAction;
  readonly signInHref: string;
}) {
  const [answered, post, posting] = useFormAction(
    claim,
    initialUsernameForm,
    claimUnavailable,
  );
  const [local, setLocal] = useState<LocalNotice>(undefined);
  const router = useRouter();
  useEffect(() => {
    if (answered.next !== undefined) router.replace(answered.next);
  }, [answered.next, router]);
  // Moving on keeps the form busy until the next page replaces it.
  const pending = posting || answered.next !== undefined;
  return (
    <UsernameForm
      username={answered.username}
      pending={pending}
      notice={shownNotice({ local, answered: answered.notice, pending })}
      action={post}
      check={(username) => {
        const refused = refusesShape(username);
        setLocal(refused ? 'invalid' : undefined);
        return !refused;
      }}
      edited={() => setLocal('edited')}
      signInHref={signInHref}
    />
  );
}

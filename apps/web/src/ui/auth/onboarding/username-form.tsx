import { Button } from '../../components/button/button';
import { Icon } from '../../components/icon/icon';
import { AuthFrame, AuthHeading, taglinePanel } from '../auth-frame/auth-frame';
import { CopyNotice } from '../notice/notice';
import { usernameNotices } from './username-notices';
import type { UsernameNotice } from './claim-form';
import { fieldClass } from '../email-field/field-class';

export type UsernameFormProps = {
  /** The name as last posted; the field starts from it. */
  readonly username: string;
  readonly pending: boolean;
  readonly notice?: UsernameNotice | undefined;
  /**
   * The form's POST. Given a server action, React renders a form the browser
   * can submit before hydration or without JavaScript.
   */
  readonly action: (form: FormData) => void | Promise<void>;
  /** The local shape check; a refused name is not posted. */
  readonly check: (username: string) => boolean;
  /** The person typed since the last answer. */
  readonly edited: () => void;
  /** Where to sign in again and come back here, when the session ended. */
  readonly signInHref: string;
};

type Submitted = {
  readonly currentTarget: {
    readonly elements: { namedItem: (name: string) => unknown };
  };
  readonly preventDefault: () => void;
};

const typedName = (event: Submitted): string => {
  const field = event.currentTarget.elements.namedItem('username');
  return field !== null && typeof field === 'object' && 'value' in field
    ? String(field.value)
    : '';
};

const NOTICE_ID = 'username-notice';
const HINT_ID = 'username-hint';

/**
 * Choosing the public name. It is the identity opponents and spectators see,
 * so the form says so, states the rule up front, and keeps what was typed
 * through every recoverable error. It is a real POST: before hydration, or
 * without JavaScript, the browser submits it to the same server action.
 */
export function UsernameForm({
  username,
  pending,
  notice,
  action,
  check,
  edited,
  signInHref,
}: UsernameFormProps) {
  const copy = notice === undefined ? undefined : usernameNotices[notice];
  const refusesName = notice === 'invalid' || notice === 'taken';
  return (
    <AuthFrame panel={taglinePanel}>
      <AuthHeading eyebrow="One last step" title="Choose your username.">
        This is the name opponents and spectators see. You can play once you
        have one.
      </AuthHeading>
      <form
        action={action}
        className="flex flex-col gap-3"
        aria-busy={pending}
        onSubmit={(event: Submitted) => {
          if (!check(typedName(event))) event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="username" className={fieldClass.label}>
            Username
          </label>
          <div className={fieldClass.row}>
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={username}
              onChange={edited}
              disabled={pending}
              aria-invalid={refusesName ? true : undefined}
              aria-describedby={
                refusesName ? `${HINT_ID} ${NOTICE_ID}` : HINT_ID
              }
              className={fieldClass.input}
            />
            <Button type="submit" disabled={pending} className="h-auth-control">
              {pending ? 'Saving…' : 'Continue'}
              <Icon name="arrowRight" size={18} />
            </Button>
          </div>
          <p id={HINT_ID} className="text-sm text-ink-muted">
            3 to 32 letters, numbers, underscores or hyphens.
          </p>
        </div>
        <CopyNotice id={NOTICE_ID} copy={copy} />
        {notice === 'signed-out' ? (
          <a href={signInHref} className="self-start text-sm font-semibold">
            Sign in again
          </a>
        ) : null}
      </form>
      <p role="status" className="sr-only">
        {pending ? 'Saving your username…' : ''}
      </p>
    </AuthFrame>
  );
}

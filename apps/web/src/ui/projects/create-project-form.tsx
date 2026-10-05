import { Button } from '../components/button/button';
import { Panel } from '../components/panel/panel';
import { CopyNotice } from '../auth/notice/notice';
import type { NoticeCopy } from '../auth/sign-in-notices';
import { fieldClass } from '../auth/email-field/field-class';
import type { CreateProjectNotice } from './create-project-state';

/** What each refused create says: the problem, and the way out. */
const createProjectNotices: Readonly<Record<CreateProjectNotice, NoticeCopy>> =
  {
    invalid: {
      tone: 'error',
      title: 'That project name will not work.',
      body: 'Use 1 to 120 characters, not only spaces.',
    },
    'rate-limited': {
      tone: 'error',
      title: 'Too many new projects for now.',
      body: 'Wait a minute, then try again.',
    },
    unavailable: {
      tone: 'error',
      title: 'We could not create your project.',
      body: 'Nothing was created. Please try again shortly.',
    },
  };

/** The name field's id: the label, the notice and focus all point at it. */
export const PROJECT_NAME_ID = 'project-name';
const NOTICE_ID = 'project-name-notice';

export type CreateProjectFormProps = {
  /** The name as last posted; the field starts from it. */
  readonly name: string;
  readonly pending: boolean;
  readonly notice?: CreateProjectNotice | undefined;
  /**
   * The form's POST. Given a server action, React renders a form the browser
   * can submit before hydration or without JavaScript.
   */
  readonly action: (form: FormData) => void | Promise<void>;
};

/**
 * Creating a project from `/app`. It is a real POST: before hydration, or
 * without JavaScript, the browser submits it to the same server action. A
 * refusal comes back as the page itself with the name as typed, the notice
 * tied to the field, and the field focused by `autofocus`, which the
 * browser honours with no script at all.
 */
export function CreateProjectForm({
  name,
  pending,
  notice,
  action,
}: CreateProjectFormProps) {
  const copy = notice === undefined ? undefined : createProjectNotices[notice];
  return (
    <Panel title="New project">
      <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
        <label htmlFor={PROJECT_NAME_ID} className={fieldClass.label}>
          Project name
        </label>
        <div className={fieldClass.row}>
          <input
            id={PROJECT_NAME_ID}
            name="name"
            type="text"
            required
            autoComplete="off"
            defaultValue={name}
            disabled={pending}
            // A refused create owes the field focus; without script only
            // the attribute can pay it.
            autoFocus={notice !== undefined}
            aria-invalid={notice === 'invalid' ? true : undefined}
            aria-describedby={notice === undefined ? undefined : NOTICE_ID}
            className={fieldClass.input}
          />
          <Button type="submit" disabled={pending} className="h-auth-control">
            {pending ? 'Creating…' : 'Create project'}
          </Button>
        </div>
        <CopyNotice id={NOTICE_ID} copy={copy} />
      </form>
      <p role="status" className="sr-only">
        {pending ? 'Creating your project…' : ''}
      </p>
    </Panel>
  );
}

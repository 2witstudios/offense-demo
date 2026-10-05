'use client';

import { useFocusAfterAnswer, useFormAction } from '../form-action/form-action';
import { CreateProjectForm, PROJECT_NAME_ID } from './create-project-form';
import {
  createUnavailable,
  initialCreateProjectForm,
  type CreateProjectFormState,
} from './create-project-state';

/** The create action: a server action answering the form's next state. */
export type CreateProjectAction = (
  state: CreateProjectFormState,
  form: FormData,
) => Promise<CreateProjectFormState>;

/**
 * The `/app` create form. It posts to `create`, a server action, so a
 * submission before hydration or without JavaScript is the same POST: a
 * created project answers a 303 back to `/app`, a refusal re-renders the
 * page with the name and the notice. With JavaScript the action refreshes
 * the page's list in place, and each answer hands focus back to the name
 * field once the disabled controls are enabled again.
 */
export function NewProject({
  create,
}: {
  readonly create: CreateProjectAction;
}) {
  const [answered, post, pending] = useFormAction(
    create,
    initialCreateProjectForm,
    createUnavailable,
  );
  useFocusAfterAnswer(answered, PROJECT_NAME_ID, !pending);
  return (
    <CreateProjectForm
      name={answered.name}
      pending={pending}
      notice={pending ? undefined : answered.notice}
      action={post}
    />
  );
}

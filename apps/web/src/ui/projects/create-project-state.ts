import type { CreateProject } from './create-project';

export type CreateProjectNotice = 'invalid' | 'rate-limited' | 'unavailable';

/** What the create form shows: the name as typed, and why it was refused. */
export type CreateProjectFormState = {
  readonly name: string;
  readonly notice?: CreateProjectNotice;
};

export const initialCreateProjectForm: CreateProjectFormState = { name: '' };

/** How one posted create form ended. Only `created` moves on. */
export type CreateSubmission =
  | { readonly kind: 'created' }
  | { readonly kind: 'refused'; readonly state: CreateProjectFormState };

const postedName = (form: FormData): string => {
  const field = form.get('name');
  return typeof field === 'string' ? field : '';
};

const refused = (
  name: string,
  notice: CreateProjectNotice,
): CreateSubmission => ({ kind: 'refused', state: { name, notice } });

/**
 * One posted create form, created through `create`. The form is untrusted:
 * a missing or non-text field is an empty name, which the route refuses
 * like any other invalid one. The name goes to the route exactly as typed;
 * the route alone judges it. A create that throws is unavailable, never a
 * success.
 */
export async function submitCreate(
  create: CreateProject,
  form: FormData,
): Promise<CreateSubmission> {
  const name = postedName(form);
  let outcome: Awaited<ReturnType<CreateProject>>;
  try {
    outcome = await create(name);
  } catch {
    return refused(name, 'unavailable');
  }
  return outcome.kind === 'created'
    ? { kind: 'created' }
    : refused(name, outcome.kind);
}

/**
 * A posted form whose create never reached the server, because the
 * browser's call to the action failed in transport.
 */
export const createUnavailable = (form: FormData): CreateProjectFormState => ({
  name: postedName(form),
  notice: 'unavailable',
});

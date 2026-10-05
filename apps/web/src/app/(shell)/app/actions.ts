'use server';

import { refresh } from 'next/cache';
import { headers } from 'next/headers';
import { moveOn } from '../../../server/form-action';
import { inProcessFetch } from '../../../server/in-process-fetch';
import { processRoute } from '../../../server/process-app';
import { createCreateProject } from '../../../ui/projects/create-project';
import {
  submitCreate,
  type CreateProjectFormState,
} from '../../../ui/projects/create-project-state';

const createRoute = processRoute((routes) => routes.projects.POST);

/**
 * The `/app` create form's POST, as a server action: it works before
 * hydration and without JavaScript. It runs the POST /api/projects handler
 * in process with this request's headers, so the same-origin, identity,
 * `authorizeRequest`, create-ceiling and body gates all apply; the action
 * never touches the database. The form is read defensively. A refusal comes
 * back as state with the name as typed. A created project moves on to
 * `/app` (`moveOn`): a 303 without JavaScript, so a reload never posts
 * again and the name never reaches a URL; with JavaScript the page is
 * already `/app`, so `refresh` re-renders its list in this answer instead.
 */
export async function createProjectAction(
  _state: CreateProjectFormState,
  form: unknown,
): Promise<CreateProjectFormState> {
  const incoming = new Headers(await headers());
  const create = createCreateProject(inProcessFetch(createRoute, incoming));
  const result = await submitCreate(
    create,
    form instanceof FormData ? form : new FormData(),
  );
  if (result.kind === 'refused') return result.state;
  moveOn(incoming, '/app');
  refresh();
  return { name: '' };
}

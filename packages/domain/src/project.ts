import { createAppError, createInvariantError } from '@offense-demo/errors';
import { projectInvariantIds } from './invariant-ids';

/**
 * The example aggregate: a named project that can be renamed and archived.
 * Every transition is a pure function from a snapshot to a new snapshot.
 * Time and identity are injected, and a rejected operation throws before
 * producing anything, so the caller's state is never touched. Replace this
 * aggregate with the product's own domain; keep the shape.
 */
export type ProjectStatus = 'active' | 'archived';

export type Project = {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Injected time source (UTC ISO timestamps). */
type Clock = { now(): string };
/** Injected identity source (cuid2 in production, fixed lists in tests). */
type IdGenerator = { next(): string };

const projectNameMaxLength = 120;

function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > projectNameMaxLength)
    throw createInvariantError(
      projectInvariantIds.nameValid,
      `Project names must be 1-${projectNameMaxLength} characters`,
    );
  return trimmed;
}

function requireActive(project: Project): void {
  if (project.status === 'archived')
    throw createInvariantError(
      projectInvariantIds.archivedIsTerminal,
      'Archived projects are terminal',
    );
}

export function createProject(
  input: { readonly name: string },
  deps: { readonly clock: Clock; readonly ids: IdGenerator },
): Project {
  const name = validName(input.name);
  const now = deps.clock.now();
  return {
    version: 1,
    id: deps.ids.next(),
    name,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

export function renameProject(
  project: Project,
  name: string,
  deps: { readonly clock: Clock },
): Project {
  requireActive(project);
  const next = validName(name);
  if (next === project.name)
    throw createInvariantError(
      projectInvariantIds.renameChangesName,
      'A rename must change the name',
    );
  return { ...project, name: next, updatedAt: deps.clock.now() };
}

export function archiveProject(
  project: Project,
  deps: { readonly clock: Clock },
): Project {
  requireActive(project);
  return { ...project, status: 'archived', updatedAt: deps.clock.now() };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/** Restores a project from its versioned JSON representation, failing closed. */
export function restoreProject(input: unknown): Project {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    !isText(input.id) ||
    typeof input.name !== 'string' ||
    (input.status !== 'active' && input.status !== 'archived') ||
    !isText(input.createdAt) ||
    !isText(input.updatedAt)
  )
    throw createAppError('VALIDATION', 'Invalid project snapshot');
  return {
    version: 1,
    id: input.id,
    name: validName(input.name),
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

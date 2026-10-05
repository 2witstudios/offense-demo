import { restoreProject, type Project } from '@offense-demo/domain';
import type { ProjectRecord } from '@offense-demo/db';

/** What `/api/projects` answers for one project: the domain snapshot's fields. */
export type ProjectDto = Pick<
  Project,
  'id' | 'name' | 'status' | 'createdAt' | 'updatedAt'
>;

/**
 * The stored form of a project the domain just created: its own fields,
 * timestamps included (DEC-3), owned by the principal that created it.
 */
export const toNewProjectRecord = (
  project: Project,
  ownerUserId: string,
): Omit<ProjectRecord, 'version'> => ({
  id: project.id,
  ownerUserId,
  name: project.name,
  status: project.status,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

/**
 * A stored project back through the domain (`restoreProject`, which fails
 * closed on a row the domain would not accept), as the API answers it.
 * The owner and the row's concurrency counter stay on the server.
 */
export const toProjectDto = (record: ProjectRecord): ProjectDto => {
  const { id, name, status, createdAt, updatedAt } = restoreProject({
    version: 1,
    id: record.id,
    name: record.name,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return { id, name, status, createdAt, updatedAt };
};

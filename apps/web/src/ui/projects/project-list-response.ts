import { createAppError } from '@offense-demo/errors';
import { z } from 'zod';

/** What `/app` renders of one project from GET /api/projects. */
export type ProjectListItem = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
};

const listBody = z.object({
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), createdAt: z.iso.datetime() }),
  ),
});

/**
 * The member's projects from the GET /api/projects answer that `/app`
 * read through `readRoute`, in the route's order. A refused read or a body
 * that is not the list fails closed as `INTERNAL` (the page's error
 * boundary) rather than rendering an empty list that would read as "no
 * projects": `requireAccess` has already admitted a member, so the route
 * refusing them is a fault, not an answer.
 */
export async function projectListFrom(
  response: Response,
): Promise<readonly ProjectListItem[]> {
  if (!response.ok)
    throw createAppError(
      'INTERNAL',
      `GET /api/projects answered ${response.status}`,
    );
  const parsed = listBody.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success)
    throw createAppError(
      'INTERNAL',
      'GET /api/projects answered an unexpected body',
      parsed.error,
    );
  return parsed.data.projects.map(({ id, name, createdAt }) => ({
    id,
    name,
    createdAt,
  }));
}

import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { desc, eq } from 'drizzle-orm';
import { createAppError } from '@offense-demo/errors';
import { projects, type ProjectStatus } from './schema/projects';
import { instrumented, type DatabaseEventSink } from './instrumented';
import { isForeignKeyViolation } from './sql-state';

/**
 * A stored project as a plain record (never a domain entity: `packages/db`
 * does not import `@offense-demo/domain`). Timestamps are UTC ISO strings.
 */
type ProjectRecord = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** A new project: every stored field but `version`, which starts at 1. */
type NewProjectRecord = Omit<ProjectRecord, 'version'>;

/** The most projects one list read returns. */
const PROJECT_LIST_MAX = 100;

const toRecord = (row: typeof projects.$inferSelect): ProjectRecord => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  name: row.name,
  status: row.status as ProjectStatus,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** A positive integer limit, capped at `PROJECT_LIST_MAX`. */
const listLimit = (limit: number = PROJECT_LIST_MAX): number => {
  if (!Number.isInteger(limit) || limit < 1)
    throw createAppError(
      'VALIDATION',
      'A project list limit must be a positive integer',
    );
  return Math.min(limit, PROJECT_LIST_MAX);
};

/**
 * The projects area (PROJ-1.1), composed into `createDatabase`. Ownership
 * is the caller's principal, passed in as `ownerUserId`; nothing here
 * reads it from input it did not validate.
 */
export const projectOperations = ({
  database,
  eventSink,
}: {
  readonly database: BunSQLDatabase;
  readonly eventSink?: DatabaseEventSink | undefined;
}) => ({
  /**
   * Stores a new project with the record's own timestamps (DEC-3) and
   * returns the row as stored. An owner id that names no user is refused by
   * the foreign key, so no row is written, and fails as `VALIDATION`.
   */
  async insertProject(record: NewProjectRecord): Promise<ProjectRecord> {
    return instrumented(eventSink, 'insertProject', async () => {
      try {
        const [row] = await database
          .insert(projects)
          .values({
            id: record.id,
            ownerUserId: record.ownerUserId,
            name: record.name,
            status: record.status,
            createdAt: new Date(record.createdAt),
            updatedAt: new Date(record.updatedAt),
          })
          .returning();
        if (!row) throw new Error('Project insert returned no row');
        return toRecord(row);
      } catch (error) {
        if (isForeignKeyViolation(error))
          throw createAppError(
            'VALIDATION',
            'Project owner is not a user',
            error,
          );
        throw error;
      }
    });
  },
  /**
   * One owner's projects, newest first (`created_at desc, id desc`, so ties
   * have one stable order), at most 100 (`limit` defaults to and is capped
   * at 100; a non-positive or fractional limit is refused as `VALIDATION`).
   */
  async listProjectsForOwner(
    ownerUserId: string,
    options: { readonly limit?: number } = {},
  ): Promise<ProjectRecord[]> {
    const limit = listLimit(options.limit);
    return instrumented(eventSink, 'listProjectsForOwner', async () => {
      const rows = await database
        .select()
        .from(projects)
        .where(eq(projects.ownerUserId, ownerUserId))
        .orderBy(desc(projects.createdAt), desc(projects.id))
        .limit(limit);
      return rows.map(toRecord);
    });
  },
});

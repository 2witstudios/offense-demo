import type { Identity } from '@offense-demo/auth';
import type { Clock, IdGenerator } from '@offense-demo/clock';
import type { Database, ProjectRecord } from '@offense-demo/db';
import { createProject } from '@offense-demo/domain';
import { createAppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import type { Capability } from '@offense-demo/protocol';
import { z } from 'zod';
import { consumeOrThrow, type AuthRateLimiter } from '../auth/rate-limit';
import { createAuthorizeRequest } from '../../server/authorize-request';
import {
  handleOperation,
  parseValidated,
  readJson,
  requireSameOrigin,
  requireSameOriginRead,
} from '../../server/http';
import { toNewProjectRecord, toProjectDto } from './project-record';

/**
 * ISSUE-3: one member's project creations. Generous for a person setting up
 * their work, and a hard ceiling on how fast one account can fill the
 * table. Spent after authorization and before the body is read (ADR 0020).
 */
export const PROJECT_CREATE_RULE = { windowSeconds: 60, max: 10 } as const;

/** The collection both capabilities are asked of (ADR 0048 section 2). */
const projectsResource = { kind: 'projects' } as const;

type SharedDependencies = {
  readonly logger: Logger;
  readonly origin: () => string;
  /** Principal resolution from the request's cookies only. */
  readonly identify: (request: Request) => Promise<Identity>;
  /** The authorization fact loader, `database.loadAuthorizationContext`. */
  readonly loadContext: Database['loadAuthorizationContext'];
};

/**
 * The one authorization gate (ADR 0048): `authorizeRequest` refuses every
 * identity but a member, so what it allows is always a user principal; the
 * id comes from the session, never from input.
 */
async function authorizedUserId(
  dependencies: SharedDependencies,
  logger: Logger,
  request: Request,
  capability: Capability,
): Promise<string> {
  const identity = await dependencies.identify(request);
  await createAuthorizeRequest({
    loadContext: dependencies.loadContext,
    logger,
  })(identity, capability, projectsResource);
  if (identity.principal.kind !== 'user') throw createAppError('NOT_FOUND');
  return identity.principal.userId;
}

type CreateProjectDependencies = SharedDependencies & {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limiter: () => AuthRateLimiter;
  readonly insertProject: (
    record: Omit<ProjectRecord, 'version'>,
  ) => Promise<ProjectRecord>;
};

/** The body is exactly `{ name }`: any other field, an owner id included, is a refusal. */
const createBody = z.strictObject({ name: z.string() });

/**
 * POST /api/projects: creates one project for the caller. Gate order is
 * ADR 0020 / ADR 0048: same origin, Principal, `authorizeRequest`
 * (`project.create`), the per-user ceiling (ISSUE-3), and only then the
 * strict body. The domain's `createProject` makes the project with the
 * app's clock and ids and enforces the name invariant; the owner is the
 * session principal.
 */
export function createCreateProjectHandler(
  dependencies: CreateProjectDependencies,
) {
  return (request: Request) =>
    handleOperation(
      dependencies.logger,
      request,
      'projects.create',
      async (_id, logger) => {
        requireSameOrigin(request, dependencies.origin());
        const userId = await authorizedUserId(
          dependencies,
          logger,
          request,
          'project.create',
        );
        await consumeOrThrow(
          dependencies.limiter(),
          `projects:create:${userId}`,
          PROJECT_CREATE_RULE,
        );
        const { name } = parseValidated(createBody, await readJson(request));
        const project = createProject(
          { name },
          { clock: dependencies.clock, ids: dependencies.ids },
        );
        const record = await dependencies.insertProject(
          toNewProjectRecord(project, userId),
        );
        return Response.json(
          { project: toProjectDto(record) },
          { status: 201 },
        );
      },
    );
}

type ListProjectsDependencies = SharedDependencies & {
  readonly listProjectsForOwner: (
    ownerUserId: string,
  ) => Promise<readonly ProjectRecord[]>;
};

/**
 * GET /api/projects: the caller's own projects, newest first, at most the
 * store's 100. A read capability, so every refusal answers `NOT_FOUND`
 * (ADR 0048 section 3). `/app` reads it in process through `readRoute`.
 */
export function createListProjectsHandler(
  dependencies: ListProjectsDependencies,
) {
  return (request: Request) =>
    handleOperation(
      dependencies.logger,
      request,
      'projects.list',
      async (_id, logger) => {
        requireSameOriginRead(request, dependencies.origin());
        const userId = await authorizedUserId(
          dependencies,
          logger,
          request,
          'project.list',
        );
        const records = await dependencies.listProjectsForOwner(userId);
        return Response.json({ projects: records.map(toProjectDto) });
      },
    );
}

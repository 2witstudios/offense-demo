import type { Identity } from '@offense-demo/auth';
import { fixedClock, fixedIds } from '@offense-demo/clock';
import type { ProjectRecord } from '@offense-demo/db';
import { createEventRecorder } from '../../server/test-loggers.test-support';
import {
  createCreateProjectHandler,
  createListProjectsHandler,
} from './projects';

const appOrigin = 'http://localhost:3000';
export const now = '2026-10-05T09:30:00.000Z';

const member: Identity = {
  state: 'member',
  username: 'ada',
  principal: { kind: 'user', userId: 'user1' },
};
export const provisional: Identity = {
  state: 'provisional',
  principal: { kind: 'user', userId: 'user1' },
};
export const anonymous: Identity = {
  state: 'anonymous',
  principal: { kind: 'anonymous' },
};
export const unavailable: Identity = {
  state: 'unavailable',
  principal: { kind: 'anonymous' },
};

type Decision = { allowed: boolean; retryAfterSeconds: number };

export const stored = (
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord => ({
  id: 'p1',
  ownerUserId: 'user1',
  name: 'Alpha',
  status: 'active',
  version: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

/**
 * Both handlers over scripted seams: the real `authorizeRequest` (over a
 * scripted fact loader), a recording limiter, and a recording store whose
 * insert echoes the record back as stored.
 */
export const setup = ({
  identity = member,
  decide = async (): Promise<Decision> => ({
    allowed: true,
    retryAfterSeconds: 0,
  }),
  listed = [] as ProjectRecord[],
}: {
  identity?: Identity;
  decide?: () => Promise<Decision>;
  listed?: ProjectRecord[];
} = {}) => {
  const calls = {
    identify: 0,
    loads: [] as unknown[],
    consumed: [] as unknown[],
    inserted: [] as unknown[],
    listed: [] as unknown[],
  };
  const { logged, logger } = createEventRecorder();
  const dependencies = {
    logger,
    origin: () => appOrigin,
    identify: async () => {
      calls.identify += 1;
      return identity;
    },
    loadContext: async (input: {
      userId: string | null;
      resourceRef: { kind: 'projects' };
    }) => {
      calls.loads.push(input);
      return { resource: input.resourceRef, accountErased: false };
    },
  };
  const create = createCreateProjectHandler({
    ...dependencies,
    clock: fixedClock(now),
    ids: fixedIds(['p1']),
    limiter: () => ({
      consume: async (key, rule) => {
        calls.consumed.push({ key, rule });
        return decide();
      },
    }),
    insertProject: async (record) => {
      calls.inserted.push(record);
      return { ...record, version: 1 };
    },
  });
  const list = createListProjectsHandler({
    ...dependencies,
    listProjectsForOwner: async (ownerUserId) => {
      calls.listed.push(ownerUserId);
      return listed;
    },
  });
  return { create, list, calls, logged };
};

export const post = (
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${appOrigin}/api/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: appOrigin,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

export const get = (headers: Record<string, string> = {}): Request =>
  new Request(`${appOrigin}/api/projects`, { method: 'GET', headers });

/** Status and public error code (or the body when it is not an error). */
export const answer = async (response: Response) => {
  const body = (await response.json()) as {
    error?: { code: string; invariantId?: string };
  };
  return {
    status: response.status,
    code: body.error?.code,
    invariantId: body.error?.invariantId,
  };
};

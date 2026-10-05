import { createDocumentationEvent } from './docs-pipeline';

type EventInput = Parameters<typeof createDocumentationEvent>[0];

/** A merged pull request's documentation event input; override any field. */
export const mergedPullRequestEvent = (overrides: Partial<EventInput> = {}) =>
  createDocumentationEvent({
    eventId: 'evt-1',
    eventType: 'pull_request.merged',
    occurredAt: '2026-09-20T00:00:00.000Z',
    repository: 'offense-demo',
    baseRef: 'main',
    commit: 'abc123',
    pullRequest: {
      number: 12,
      title: 'feat: add tournaments',
      body: null,
      url: 'https://github.test/pr/12',
      author: 'alice',
      mergedBy: 'bob',
    },
    taskIds: ['ENG-1.1'],
    changedFiles: ['packages/protocol/src/events.ts'],
    ...overrides,
  });

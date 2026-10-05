import type { ProjectScenario } from '../scripts/scenario';

/** Create, rename, archive; a rename after archival is refused atomically. */
const scenario: ProjectScenario = {
  name: 'project-lifecycle',
  given: {
    clock: '2026-01-01T00:00:00.000Z',
    ids: ['scenario-project-1'],
    projectName: 'Roadmap',
  },
  when: [
    { type: 'rename', name: 'Launch plan' },
    { type: 'archive' },
    {
      type: 'expect-rejection',
      operation: { type: 'rename', name: 'Revived' },
      invariantId: 'project.archived.terminal',
    },
  ],
  expect: {
    id: 'scenario-project-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    name: 'Launch plan',
    status: 'archived',
  },
};

export default scenario;

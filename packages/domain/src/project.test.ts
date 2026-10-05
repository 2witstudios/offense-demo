import { assertRejects } from '@offense-demo/errors/testing';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  archiveProject,
  createProject,
  renameProject,
  restoreProject,
  type Project,
} from './index';

setupRitewayBun();

const created = '2026-01-01T00:00:00.000Z';
const later = '2026-01-02T00:00:00.000Z';
const projectId = 'k2v9x0f4m8q3w1z7c5n6b4d2';
const clockAt = (instant: string) => ({ now: () => instant });
const ids = { next: () => projectId };
const make = (name = 'Roadmap'): Project =>
  createProject({ name }, { clock: clockAt(created), ids });

describe('project lifecycle', () => {
  test('create stamps the injected id and clock', () => {
    assert({
      given: 'a name with surrounding whitespace and injected clock and ids',
      should: 'create an active project with a trimmed name',
      actual: make('  Roadmap  '),
      expected: {
        version: 1,
        id: projectId,
        name: 'Roadmap',
        status: 'active',
        createdAt: created,
        updatedAt: created,
      },
    });
  });

  test('rename and archive return new snapshots', () => {
    const project = make();
    const renamed = renameProject(project, 'Plan', { clock: clockAt(later) });
    assert({
      given: 'an active project renamed',
      should: 'carry the new name and the injected update time',
      actual: { name: renamed.name, updatedAt: renamed.updatedAt },
      expected: { name: 'Plan', updatedAt: later },
    });
    assert({
      given: 'the original snapshot after a rename',
      should: 'stay unchanged',
      actual: project.name,
      expected: 'Roadmap',
    });
    assert({
      given: 'an active project archived',
      should: 'become archived',
      actual: archiveProject(renamed, { clock: clockAt(later) }).status,
      expected: 'archived',
    });
  });

  test('invalid names are rejected', async () => {
    await assertRejects({
      given: 'a blank project name',
      should: 'refuse with project.name.valid',
      actual: () => make('   '),
      code: 'INVARIANT',
      invariantId: 'project.name.valid',
    });
  });

  test('a rename must change the name', async () => {
    const project = make();
    await assertRejects({
      given: 'a rename to the current name',
      should: 'refuse with project.rename.changes-name',
      actual: () =>
        renameProject(project, ' Roadmap ', { clock: clockAt(later) }),
      code: 'INVARIANT',
      invariantId: 'project.rename.changes-name',
    });
  });

  test('archived projects are terminal', async () => {
    const archived = archiveProject(make(), { clock: clockAt(later) });
    const before = JSON.stringify(archived);
    await assertRejects({
      given: 'an archived project renamed',
      should: 'refuse with project.archived.terminal',
      actual: () => renameProject(archived, 'Other', { clock: clockAt(later) }),
      code: 'INVARIANT',
      invariantId: 'project.archived.terminal',
    });
    await assertRejects({
      given: 'an archived project archived again',
      should: 'refuse with project.archived.terminal',
      actual: () => archiveProject(archived, { clock: clockAt(later) }),
      code: 'INVARIANT',
      invariantId: 'project.archived.terminal',
    });
    assert({
      given: 'rejected operations',
      should: 'leave the snapshot unchanged',
      actual: JSON.stringify(archived),
      expected: before,
    });
  });
});

describe('project restoration', () => {
  test('a JSON round trip restores an equal project', () => {
    const project = make();
    assert({
      given: 'a JSON round trip of a project snapshot',
      should: 'restore an equal snapshot',
      actual: restoreProject(JSON.parse(JSON.stringify(project))),
      expected: project,
    });
  });

  test('malformed snapshots fail closed', async () => {
    await assertRejects({
      given: 'a snapshot with an unknown status',
      should: 'refuse as a validation error',
      actual: () => restoreProject({ ...make(), status: 'deleted' }),
      code: 'VALIDATION',
    });
    await assertRejects({
      given: 'a snapshot with an invalid name',
      should: 'refuse with project.name.valid',
      actual: () => restoreProject({ ...make(), name: '' }),
      code: 'INVARIANT',
      invariantId: 'project.name.valid',
    });
  });
});

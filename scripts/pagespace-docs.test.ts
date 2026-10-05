import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { documentationDrive, documentationLocation } from './pagespace-docs';
import {
  fakeId,
  provisionedConfig,
  thrown,
  unprovisionedConfig,
} from './project-config.test-support';

setupRitewayBun();

describe('documentationLocation', () => {
  test('reads the drive, folder and agent from project config', () => {
    assert({
      given: 'a provisioned config and no overrides',
      should: 'use the configured drive, Documentation folder and agent',
      actual: documentationLocation(provisionedConfig(), {}),
      expected: {
        driveId: fakeId('drive'),
        rootPageId: fakeId('p', 'documentation'),
        agentPageId: fakeId('a', 'documentation'),
      },
    });
  });

  test('environment overrides win over config', () => {
    assert({
      given: 'staging overrides for drive, folder and agent',
      should: 'use the overrides',
      actual: documentationLocation(unprovisionedConfig(), {
        PAGESPACE_DOCUMENTATION_DRIVE_ID: 'staging-drive',
        PAGESPACE_DOCUMENTATION_ROOT_PAGE_ID: 'staging-root',
        PAGESPACE_DOCUMENTATION_AGENT_PAGE_ID: 'staging-agent',
      }),
      expected: {
        driveId: 'staging-drive',
        rootPageId: 'staging-root',
        agentPageId: 'staging-agent',
      },
    });
  });

  test('an unprovisioned drive fails with a bootstrap hint', () => {
    assert({
      given: 'a config whose drive is not bootstrapped and no overrides',
      should: 'refuse naming the missing key and the bootstrap command',
      actual: thrown(() => documentationLocation(unprovisionedConfig(), {})),
      expected:
        'pagespace.driveId is not provisioned in project.config.json; run `bun drive:bootstrap`',
    });
  });
});

describe('documentationDrive', () => {
  test('maps the merge pipelines to their configured target pages', () => {
    const drive = documentationDrive(provisionedConfig(), {});
    assert({
      given: 'a provisioned config',
      should: 'carry the runs sheet and the three merge target pages',
      actual: { runsSheetId: drive.runsSheetId, targets: drive.targetPages },
      expected: {
        runsSheetId: fakeId('p', 'docsRunsSheet'),
        targets: {
          'technical-docs': fakeId('p', 'technicalDocs'),
          'user-docs': fakeId('p', 'userDocs'),
          blog: fakeId('p', 'blog'),
        },
      },
    });
  });

  test('omits a target page that is not provisioned', () => {
    const config = provisionedConfig();
    const drive = documentationDrive(
      {
        ...config,
        pagespace: {
          ...config.pagespace,
          pages: { ...config.pagespace.pages, blog: null },
        },
      },
      {},
    );
    assert({
      given: 'a config without a blog page',
      should: 'route no blog target',
      actual: Object.keys(drive.targetPages),
      expected: ['technical-docs', 'user-docs'],
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { issueListIds } from './board-model';
import {
  fakeId,
  provisionedConfig,
  unprovisionedConfig,
} from './project-config.test-support';

setupRitewayBun();

describe('issueListIds', () => {
  test('lists the Issues root and every provisioned bucket from config', () => {
    const config = provisionedConfig();
    assert({
      given: 'a provisioned config with one bucket left unprovisioned',
      should: 'return the root first, then each provisioned bucket in order',
      actual: issueListIds({
        ...config,
        pagespace: {
          ...config.pagespace,
          pages: { ...config.pagespace.pages, docDrift: null },
        },
      }),
      expected: [
        fakeId('p', 'issues'),
        fakeId('p', 'bugs'),
        fakeId('p', 'testCoverage'),
        fakeId('p', 'agentTooling'),
        fakeId('p', 'userFeedback'),
        fakeId('p', 'backlog'),
        fakeId('p', 'pendingDecisions'),
      ],
    });
  });

  test('refuses when the Issues list is not provisioned', () => {
    let message = 'no throw';
    try {
      issueListIds(unprovisionedConfig());
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a config whose drive is not bootstrapped',
      should: 'name the missing Issues page',
      actual: message,
      expected:
        'pagespace.pages.issues is not provisioned in project.config.json; run `bun drive:bootstrap`',
    });
  });
});

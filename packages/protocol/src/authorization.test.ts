import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  capabilities,
  capabilityMetadata,
  capabilitySchema,
  denyReasons,
  resourceKinds,
} from './authorization';

setupRitewayBun();

describe('authorization vocabulary', () => {
  test('the example aggregate has a create and a list capability', () => {
    assert({
      given: 'the capability metadata',
      should:
        'ask project.create (non-read) and project.list (read) of the projects collection',
      actual: capabilities.map((capability) => [
        capability,
        capabilityMetadata[capability],
      ]),
      expected: [
        ['project.create', { resourceKinds: ['projects'], read: false }],
        ['project.list', { resourceKinds: ['projects'], read: true }],
      ],
    });
  });

  test('every capability is asked of known resource kinds only', () => {
    assert({
      given: 'each capability’s resource kinds',
      should: 'name only kinds in the resource-kind vocabulary',
      actual: capabilities.every((capability) =>
        capabilityMetadata[capability].resourceKinds.every((kind) =>
          (resourceKinds as readonly string[]).includes(kind),
        ),
      ),
      expected: true,
    });
  });

  test('the capability schema admits the vocabulary and nothing else', () => {
    assert({
      given: 'each capability, an unknown one and a non-string',
      should: 'accept only the vocabulary',
      actual: [...capabilities, 'project.delete', 7].map(
        (value) => capabilitySchema.safeParse(value).success,
      ),
      expected: [true, true, false, false],
    });
  });

  test('the deny reasons are the denyReason log vocabulary', () => {
    assert({
      given: 'the deny reasons',
      should: 'be exactly the four ADR 0048 reasons',
      actual: denyReasons,
      expected: [
        'denied',
        'account-erased',
        'unauthenticated',
        'missing-capability',
      ],
    });
  });
});

import { assertRejects, rejectionOf } from '@offense-demo/errors/testing';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requirePermission, type Permission } from './index';

setupRitewayBun();

describe('requirePermission', () => {
  test('authentication and authorization are distinct explicit boundaries', async () => {
    await assertRejects({
      given: 'an anonymous principal',
      should: 'refuse with AUTHENTICATION',
      actual: () => requirePermission({ kind: 'anonymous' }, 'app:write'),
      code: 'AUTHENTICATION',
    });
    await assertRejects({
      given: 'a signed-in user holding no permissions',
      should: 'refuse with AUTHORIZATION',
      actual: () =>
        requirePermission(
          { kind: 'user', userId: 'u', permissions: [] },
          'app:write',
        ),
      code: 'AUTHORIZATION',
    });
    assert({
      given: 'a service principal holding the required permission',
      should: 'admit the operation',
      actual: await rejectionOf(() =>
        requirePermission(
          { kind: 'service', serviceId: 's', permissions: ['app:write'] },
          'app:write',
        ),
      ),
      expected: { code: 'NO_REJECTION' },
    });
  });

  test('app:read is its own permission, separate from app:write', async () => {
    const outcome = (held: readonly Permission[], required: Permission) =>
      rejectionOf(() =>
        requirePermission(
          { kind: 'service', serviceId: 's', permissions: held },
          required,
        ),
      );
    assert({
      given: 'principals holding exactly one permission each',
      should: 'admit reads only for app:read and writes only for app:write',
      actual: {
        readWithRead: await outcome(['app:read'], 'app:read'),
        readWithWrite: await outcome(['app:write'], 'app:read'),
        writeWithWrite: await outcome(['app:write'], 'app:write'),
        writeWithRead: await outcome(['app:read'], 'app:write'),
      },
      expected: {
        readWithRead: { code: 'NO_REJECTION' },
        readWithWrite: { code: 'AUTHORIZATION' },
        writeWithWrite: { code: 'NO_REJECTION' },
        writeWithRead: { code: 'AUTHORIZATION' },
      },
    });
  });
});

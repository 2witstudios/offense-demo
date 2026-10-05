import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Identity } from '@offense-demo/auth';
import { rejectionOf } from '@offense-demo/errors/testing';
import type { Capability } from '@offense-demo/protocol';
import { createAuthorizeRequest } from './authorize-request';
import { createEventRecorder } from './test-loggers.test-support';

setupRitewayBun();

const projects = { kind: 'projects' } as const;
const anonymous: Identity = {
  state: 'anonymous',
  principal: { kind: 'anonymous' },
};
const unavailable: Identity = {
  state: 'unavailable',
  principal: { kind: 'anonymous' },
};
const provisional: Identity = {
  state: 'provisional',
  principal: { kind: 'user', userId: 'user1' },
};
const member: Identity = {
  state: 'member',
  username: 'ada',
  principal: { kind: 'user', userId: 'user1' },
};

/** A bound authorizeRequest over a scripted loader, recording loads and logs. */
const setup = ({
  accountErased = false,
  exists = true,
}: { accountErased?: boolean; exists?: boolean } = {}) => {
  const loads: unknown[] = [];
  const { logged, logger } = createEventRecorder();
  const authorizeRequest = createAuthorizeRequest({
    logger,
    loadContext: async (input) => {
      loads.push(input);
      return { resource: exists ? input.resourceRef : null, accountErased };
    },
  });
  return { authorizeRequest, loads, logged };
};

const outcome = async (
  identity: Identity,
  capability: Capability,
  facts: Parameters<typeof setup>[0] = {},
) => {
  const { authorizeRequest, loads, logged } = setup(facts);
  return {
    result: await rejectionOf(() =>
      authorizeRequest(identity, capability, projects),
    ),
    loads: loads.length,
    logged,
  };
};

const denial = (denyReason: string) => [
  { event: 'authz.denied', fields: { denyReason } },
];

describe('authorizeRequest', () => {
  test('a member is allowed and gets the loaded resource back', async () => {
    const { authorizeRequest, loads, logged } = setup();
    assert({
      given: 'a member asking project.create of the projects collection',
      should: 'load the member’s facts, log nothing and return the resource',
      actual: {
        resource: await authorizeRequest(member, 'project.create', projects),
        loads,
        logged,
      },
      expected: {
        resource: projects,
        loads: [{ userId: 'user1', resourceRef: projects }],
        logged: [],
      },
    });
  });

  test('an unavailable identity answers 503 without loading or deciding', async () => {
    assert({
      given: 'a session store outage, for a non-read and a read',
      should: 'refuse with INFRASTRUCTURE, load nothing and log no denial',
      actual: [
        await outcome(unavailable, 'project.create'),
        await outcome(unavailable, 'project.list'),
      ],
      expected: [
        { result: { code: 'INFRASTRUCTURE' }, loads: 0, logged: [] },
        { result: { code: 'INFRASTRUCTURE' }, loads: 0, logged: [] },
      ],
    });
  });

  test('a provisional account is refused before loading', async () => {
    assert({
      given: 'an account without a username, for a non-read and a read',
      should:
        'answer AUTHORIZATION for the non-read and NOT_FOUND for the read, logging missing-capability',
      actual: [
        await outcome(provisional, 'project.create'),
        await outcome(provisional, 'project.list'),
      ],
      expected: [
        {
          result: { code: 'AUTHORIZATION' },
          loads: 0,
          logged: denial('missing-capability'),
        },
        {
          result: { code: 'NOT_FOUND' },
          loads: 0,
          logged: denial('missing-capability'),
        },
      ],
    });
  });

  test('an anonymous visitor is asked to authenticate for a non-read only', async () => {
    assert({
      given: 'an anonymous visitor, for a non-read and a read',
      should:
        'answer AUTHENTICATION for the non-read and NOT_FOUND for the read, logging unauthenticated',
      actual: [
        await outcome(anonymous, 'project.create'),
        await outcome(anonymous, 'project.list'),
      ],
      expected: [
        {
          result: { code: 'AUTHENTICATION' },
          loads: 1,
          logged: denial('unauthenticated'),
        },
        {
          result: { code: 'NOT_FOUND' },
          loads: 1,
          logged: denial('unauthenticated'),
        },
      ],
    });
  });

  test('a denied member gets AUTHORIZATION for a non-read and NOT_FOUND for a read', async () => {
    assert({
      given: 'a member whose account is erased, for a non-read and a read',
      should: 'refuse each by its public mapping, logging account-erased',
      actual: [
        await outcome(member, 'project.create', { accountErased: true }),
        await outcome(member, 'project.list', { accountErased: true }),
      ],
      expected: [
        {
          result: { code: 'AUTHORIZATION' },
          loads: 1,
          logged: denial('account-erased'),
        },
        {
          result: { code: 'NOT_FOUND' },
          loads: 1,
          logged: denial('account-erased'),
        },
      ],
    });
  });

  test('a resource that does not exist answers NOT_FOUND like a denied read', async () => {
    assert({
      given: 'a reference the loader finds nothing for',
      should: 'answer NOT_FOUND without a denial to log',
      actual: await outcome(member, 'project.list', { exists: false }),
      expected: { result: { code: 'NOT_FOUND' }, loads: 1, logged: [] },
    });
  });
});

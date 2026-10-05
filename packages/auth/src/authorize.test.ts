import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  capabilities,
  capabilityMetadata,
  resourceKinds,
  type Capability,
  type DenyReason,
  type ResourceKind,
} from '@offense-demo/protocol';
import { authorize, toAuthorizationInput, type Decision } from './authorize';
import type { Principal } from './index';

setupRitewayBun();

const anonymous: Principal = { kind: 'anonymous' };
const user: Principal = { kind: 'user', userId: 'user1' };
const principals = { anonymous, user } as const;

/**
 * The closed input space: every principal kind, every capability, every
 * resource kind plus one outside the vocabulary (a forged runtime value the
 * types cannot stop), and every combination of deny facts.
 */
const forged = 'forged' as ResourceKind;
const kindsUnderTest = [...resourceKinds, forged] as const;
const denyFactSets = { none: [], erased: ['account-erased'] } as const;

const space = Object.entries(principals).flatMap(([principalName, principal]) =>
  capabilities.flatMap((capability) =>
    kindsUnderTest.flatMap((kind) =>
      Object.entries(denyFactSets).map(([factsName, denyFacts]) => ({
        key: `${principalName} ${capability} ${kind} ${factsName}`,
        capability,
        kind,
        decision: authorize({
          principal,
          capability,
          resource: { kind },
          context: { denyFacts },
        }),
      })),
    ),
  ),
);

const allowed: Decision = { allow: true };
const deniedFor = (reason: DenyReason): Decision => ({ allow: false, reason });

describe('authorize over the closed input space', () => {
  test('every input has exactly the decision the rules give', () => {
    assert({
      given: 'every principal kind × capability × resource kind × deny facts',
      should:
        'deny foreign kinds as denied, then erased accounts, allow signed-in users, and refuse anonymous visitors as unauthenticated',
      actual: Object.fromEntries(
        space.map(({ key, decision }) => [key, decision]),
      ),
      expected: {
        'anonymous project.create projects none': deniedFor('unauthenticated'),
        'anonymous project.create projects erased': deniedFor('account-erased'),
        'anonymous project.create forged none': deniedFor('denied'),
        'anonymous project.create forged erased': deniedFor('denied'),
        'anonymous project.list projects none': deniedFor('unauthenticated'),
        'anonymous project.list projects erased': deniedFor('account-erased'),
        'anonymous project.list forged none': deniedFor('denied'),
        'anonymous project.list forged erased': deniedFor('denied'),
        'user project.create projects none': allowed,
        'user project.create projects erased': deniedFor('account-erased'),
        'user project.create forged none': deniedFor('denied'),
        'user project.create forged erased': deniedFor('denied'),
        'user project.list projects none': allowed,
        'user project.list projects erased': deniedFor('account-erased'),
        'user project.list forged none': deniedFor('denied'),
        'user project.list forged erased': deniedFor('denied'),
      },
    });
  });

  test('deny dominance: an erased account is denied every valid capability', () => {
    const validErased = space.filter(
      ({ key, capability, kind }) =>
        key.endsWith(' erased') &&
        capabilityMetadata[capability].resourceKinds.includes(kind),
    );
    assert({
      given:
        'account-erased present, for every capability asked of a kind it allows',
      should: 'deny with account-erased whatever the allowances say',
      actual: {
        cases: validErased.length > 0,
        reasons: [
          ...new Set(
            validErased.map(({ decision }) => JSON.stringify(decision)),
          ),
        ],
      },
      expected: {
        cases: true,
        reasons: [JSON.stringify(deniedFor('account-erased'))],
      },
    });
  });

  test('resource-kind safety: nothing is allowed outside a capability’s kinds', () => {
    const foreign = space.filter(
      ({ capability, kind }) =>
        !capabilityMetadata[capability].resourceKinds.includes(kind),
    );
    assert({
      given: 'every input whose resource kind the capability does not list',
      should: 'deny each with denied, deny facts or not',
      actual: {
        cases: foreign.length > 0,
        allDenied: foreign.every(
          ({ decision }) => !decision.allow && decision.reason === 'denied',
        ),
      },
      expected: { cases: true, allDenied: true },
    });
  });
});

describe('authorize, targeted cases', () => {
  test('a capability outside the vocabulary is denied, never looked up', () => {
    assert({
      given: 'a forged capability string, including an Object prototype key',
      should: 'deny each with denied',
      actual: (['project.delete', 'toString'] as unknown as Capability[]).map(
        (capability) =>
          authorize({
            principal: user,
            capability,
            resource: { kind: 'projects' },
            context: { denyFacts: [] },
          }),
      ),
      expected: [deniedFor('denied'), deniedFor('denied')],
    });
  });

  test('rule 0 decides before a deny fact', () => {
    assert({
      given: 'an erased account asking of a foreign resource kind',
      should: 'answer denied, the first rule that decides',
      actual: authorize({
        principal: user,
        capability: 'project.create',
        resource: { kind: forged },
        context: { denyFacts: ['account-erased'] },
      }),
      expected: deniedFor('denied'),
    });
  });
});

describe('toAuthorizationInput', () => {
  test('maps a loaded projection to the resource and context', () => {
    assert({
      given: 'a live and an erased account, and an anonymous visitor',
      should:
        'carry the loaded resource and turn the tombstone into account-erased for a user only',
      actual: [
        toAuthorizationInput(
          { resource: { kind: 'projects' }, accountErased: false },
          user,
        ),
        toAuthorizationInput(
          { resource: { kind: 'projects' }, accountErased: true },
          user,
        ),
        toAuthorizationInput(
          { resource: { kind: 'projects' }, accountErased: true },
          anonymous,
        ),
      ],
      expected: [
        {
          principal: user,
          resource: { kind: 'projects' },
          context: { denyFacts: [] },
        },
        {
          principal: user,
          resource: { kind: 'projects' },
          context: { denyFacts: ['account-erased'] },
        },
        {
          principal: anonymous,
          resource: { kind: 'projects' },
          context: { denyFacts: [] },
        },
      ],
    });
  });

  test('a resource that does not exist maps to nothing to decide', () => {
    assert({
      given: 'a projection with no resource',
      should: 'answer null',
      actual: toAuthorizationInput(
        { resource: null, accountErased: false },
        user,
      ),
      expected: null,
    });
  });

  test('the resource is rebuilt from the loaded kind alone', () => {
    const loaded = {
      resource: { kind: 'projects', ownerId: 'client-said-so' },
      accountErased: false,
    } as const;
    assert({
      given: 'a projection whose resource carries an extra field',
      should: 'keep only the loaded kind',
      actual: toAuthorizationInput(loaded, user)?.resource,
      expected: { kind: 'projects' },
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  emailDeliveryStatusRank,
  emailDeliveryStatuses,
} from '@offense-demo/protocol';
import { classifyResendEvent } from './webhook';

setupRitewayBun();

describe('classifyResendEvent', () => {
  test('maps provider events to monotonic ranks and suppression only for hard failures', () => {
    const event = (type: string, data: Record<string, unknown> = {}) =>
      classifyResendEvent({ type, data: { email_id: 'em', ...data } });
    assert({
      given: 'the Resend event types',
      should:
        'rank sent < delayed < delivered < failed < bounced < complained and suppress only hard bounces and complaints',
      actual: [
        event('email.sent'),
        event('email.delivery_delayed'),
        event('email.delivered'),
        event('email.failed'),
        event('email.bounced', { bounce: { type: 'Permanent' } }),
        event('email.bounced', { bounce: { type: 'Transient' } }),
        event('email.complained'),
        event('email.opened'),
      ],
      expected: [
        { status: 'sent', rank: 1, suppress: null, messageId: 'em' },
        { status: 'delayed', rank: 2, suppress: null, messageId: 'em' },
        { status: 'delivered', rank: 3, suppress: null, messageId: 'em' },
        { status: 'failed', rank: 4, suppress: null, messageId: 'em' },
        { status: 'bounced', rank: 5, suppress: 'bounce', messageId: 'em' },
        { status: 'delayed', rank: 2, suppress: null, messageId: 'em' },
        {
          status: 'complained',
          rank: 6,
          suppress: 'complaint',
          messageId: 'em',
        },
        null,
      ],
    });
  });

  test('classifies into exactly the protocol delivery statuses, at the protocol rank', () => {
    const classified = [
      { type: 'email.sent' },
      { type: 'email.delivery_delayed' },
      { type: 'email.delivered' },
      { type: 'email.failed' },
      { type: 'email.bounced', bounce: { type: 'Permanent' } },
      { type: 'email.bounced', bounce: { type: 'Transient' } },
      { type: 'email.complained' },
    ].map(({ type, ...data }) =>
      classifyResendEvent({ type, data: { email_id: 'em', ...data } }),
    );
    assert({
      given: 'every provider event the classifier handles',
      should:
        'reach every protocol delivery status and no other, so a status added in one place fails here before the database CHECK',
      actual: [...new Set(classified.map((event) => event?.status))].sort(),
      expected: [...emailDeliveryStatuses].sort(),
    });
    assert({
      given: 'each classified provider event',
      should: 'carry the rank the protocol assigns its status',
      actual: classified.map((event) => event?.rank),
      expected: classified.map((event) =>
        event ? emailDeliveryStatusRank(event.status) : undefined,
      ),
    });
  });

  test('ignores event types that name Object.prototype members', () => {
    const types = ['constructor', 'toString', '__proto__'];
    assert({
      given: 'signed events typed constructor, toString and __proto__',
      should:
        'classify none of them: only the provider event types map to a status',
      actual: types.map((type) =>
        classifyResendEvent({ type, data: { email_id: 'em' } }),
      ),
      expected: [null, null, null],
    });
  });

  test('ignores events without a usable message id', () => {
    assert({
      given: 'a delivered event lacking data.email_id',
      should: 'be ignored',
      actual: classifyResendEvent({ type: 'email.delivered', data: {} }),
      expected: null,
    });
  });
});

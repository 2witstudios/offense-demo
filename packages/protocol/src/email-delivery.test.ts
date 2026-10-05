import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  emailDeliveryStatusRank,
  emailDeliveryStatuses,
} from './email-delivery';

setupRitewayBun();

describe('email delivery statuses', () => {
  test('rank each status by its position, so the order is the monotonic order', () => {
    assert({
      given: 'every delivery status',
      should:
        'rank sent < delayed < delivered < failed < bounced < complained, from 1',
      actual: emailDeliveryStatuses.map((status) => [
        status,
        emailDeliveryStatusRank(status),
      ]),
      expected: [
        ['sent', 1],
        ['delayed', 2],
        ['delivered', 3],
        ['failed', 4],
        ['bounced', 5],
        ['complained', 6],
      ],
    });
  });
});

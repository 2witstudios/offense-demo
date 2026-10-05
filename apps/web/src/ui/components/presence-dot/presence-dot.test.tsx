import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { PresenceDot } from './presence-dot';
import { presenceStatuses as statuses } from '@offense-demo/protocol';
import { presenceDotClass } from './presence-dot-class';

setupRitewayBun();

const base =
  'inline-block size-presence-dot rounded-round border-2 border-surface';

describe('PresenceDot', () => {
  test('names each presence without claiming to be a live region', () => {
    assert({
      given: 'each protocol presence status',
      should: 'render an img role labelled with that presence, not status',
      actual: statuses.map((presence) => {
        const html = renderToString(h(PresenceDot, { presence }));
        return (
          html.includes('role="img"') &&
          !html.includes('role="status"') &&
          html.includes(`aria-label="${presence}"`)
        );
      }),
      expected: statuses.map(() => true),
    });
  });

  test('gives every presence its own fill', () => {
    assert({
      given: 'each protocol presence status',
      should: 'add a distinct fill token to the shared dot classes',
      actual: statuses.map((presence) => presenceDotClass(presence)),
      expected: [
        `${base} bg-live`,
        `${base} bg-online`,
        `${base} bg-gold`,
        `${base} bg-ink-faint`,
      ],
    });
  });
});

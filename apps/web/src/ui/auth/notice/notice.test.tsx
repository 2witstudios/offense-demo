import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Notice, noticeIcon } from './notice';
import { noticeClass, noticeIconClass } from './notice-class';
import { signInNotices } from '../sign-in-notices';

setupRitewayBun();

describe('Notice', () => {
  test('errors interrupt, information waits', () => {
    const error = renderToString(
      h(Notice, { id: 'n', tone: 'error', title: 'Refused.' }),
    );
    const info = renderToString(
      h(Notice, { id: 'n', tone: 'info', title: 'Cancelled.' }),
    );
    assert({
      given: 'an error and an info notice',
      should: 'use alert and status roles respectively, with an icon',
      actual: [
        error.includes('role="alert"'),
        info.includes('role="status"'),
        error.includes('<svg'),
      ],
      expected: [true, true, true],
    });
  });
});

describe('noticeClass', () => {
  test('tints errors with the live colour and information neutrally', () => {
    assert({
      given: 'each tone',
      should: 'pick the tone fill and icon colour',
      actual: [
        noticeClass('error').includes('bg-live-soft'),
        noticeClass('info').includes('bg-surface-overlay'),
        noticeIconClass('error').includes('text-live'),
        noticeIconClass('info').includes('text-ink-muted'),
        noticeIcon.error,
        noticeIcon.info,
      ],
      expected: [true, true, true, true, 'alert', 'clock'],
    });
  });
});

describe('signInNotices', () => {
  test('only failures are errors', () => {
    assert({
      given: 'every sign-in notice',
      should:
        'treat a cancelled or unsupported passkey as information, the rest as errors',
      actual: Object.entries(signInNotices)
        .filter(([, copy]) => copy.tone === 'info')
        .map(([notice]) => notice),
      expected: ['passkey-cancelled', 'passkey-unsupported'],
    });
  });
});

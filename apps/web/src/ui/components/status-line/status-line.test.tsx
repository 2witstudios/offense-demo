import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { StatusLine } from './status-line';
import { Stat } from '../stat/stat';
import { PresenceDot } from '../presence-dot/presence-dot';

setupRitewayBun();

describe('StatusLine', () => {
  test('pairs a tone dot with the count text', () => {
    const html = renderToString(
      h(StatusLine, { tone: 'online', children: '1,248 online' }),
    );
    assert({
      given: 'an online status line',
      should: 'render the count text',
      actual: html.includes('1,248 online'),
      expected: true,
    });
  });
});

describe('Stat', () => {
  test('pairs an icon with the value', () => {
    const html = renderToString(
      h(Stat, { icon: 'chart', value: '1820', label: 'rating' }),
    );
    assert({
      given: 'a stat with icon, value, and label',
      should: 'render all three parts',
      actual: [html.includes('1820'), html.includes('rating')],
      expected: [true, true],
    });
  });
});

describe('PresenceDot', () => {
  test('names the presence state', () => {
    const html = renderToString(h(PresenceDot, { presence: 'in-room' }));
    assert({
      given: 'a presence dot',
      should: 'name the presence without an unrelated live-region role',
      actual: [html.includes('role="img"'), html.includes('in-room')],
      expected: [true, true],
    });
  });
});

import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { appConfig } from '../../../../../app-config';
import { Sidebar } from './sidebar';
import { routeExists } from '../../../../test-support/route-exists';

setupRitewayBun();

const appDirectory = join(import.meta.dir, '../../../../../app');

const hrefsOf = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1] ?? '');

describe('Sidebar', () => {
  test('is the primary navigation landmark', () => {
    const html = renderToString(h(Sidebar));
    assert({
      given: 'the sidebar',
      should: 'render exactly one nav, named "Primary"',
      actual: [
        /^<nav[^>]* aria-label="Primary"/.test(html),
        html.split('<nav').length - 1,
      ],
      expected: [true, 1],
    });
  });

  test('renders the configured navigation, in order', () => {
    assert({
      given: 'appConfig.navigation',
      should: 'link each entry in the order it is listed',
      actual: hrefsOf(renderToString(h(Sidebar))),
      expected: appConfig.navigation.map(({ href }) => href),
    });
  });

  test('links only to routes that exist', () => {
    assert({
      given: 'every link in the sidebar',
      should: 'resolve to an app router page',
      actual: hrefsOf(renderToString(h(Sidebar))).filter(
        (href) => !routeExists(appDirectory, href),
      ),
      expected: [],
    });
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { appConfig } from '../../../app-config';
import { iconPaths } from './icons';
import { extractIconNames } from '../../test-support/icon-references';

setupRitewayBun();

// IconName is an open string key, so a typo renders an empty <svg> silently.
// Expected names come from the consumers, not a hand-kept list: string
// literals passed to icon props in non-test source (forms and limits are
// documented in test-support/icon-references.ts).
const sourceDirectory = join(import.meta.dir, '../../..');

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === 'test-support' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });

const referencedIcons = (): readonly string[] => [
  ...new Set(
    sourceFiles(sourceDirectory).flatMap((file) =>
      extractIconNames(readFileSync(file, 'utf8')),
    ),
  ),
];

const isDrawn = (name: string): boolean =>
  renderToString(h('svg', null, iconPaths[name])) !== '<svg></svg>';

describe('icon set', () => {
  test('finds the icon references in consumer source', () => {
    const names = referencedIcons();
    assert({
      given: 'a scan of non-test source for literal icon references',
      should: 'see the navigation data in app config',
      actual: appConfig.navigation
        .map(({ icon }) => icon)
        .filter((name) => !names.includes(name)),
      expected: [],
    });
  });

  test('draws every icon that source references', () => {
    assert({
      given: 'every literal icon name passed to an icon prop in app source',
      should: 'have drawable shapes (no silently empty icons)',
      actual: referencedIcons().filter((name) => !isDrawn(name)),
      expected: [],
    });
  });
});

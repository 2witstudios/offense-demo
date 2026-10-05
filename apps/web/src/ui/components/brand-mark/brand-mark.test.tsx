import { renderToString } from 'react-dom/server';
import { createElement as h, Fragment } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { appConfig } from '../../../app-config';
import { BrandMark, BrandWordmark } from './brand-mark';
import { brandMarkGeometry, brandMarkMarkup } from './brand-mark-geometry';

setupRitewayBun();

const classesOf = (html: string) =>
  [...html.matchAll(/<(?:rect|circle)[^>]* class="([^"]+)"/g)].map(
    ([, className]) => className,
  );

describe('BrandMark', () => {
  test('draws the square and disc at the requested size, hidden from assistive tech', () => {
    const html = renderToString(h(BrandMark, { size: 24, variant: 'primary' }));
    assert({
      given: 'a primary mark at 24px',
      should: 'render one rect and one circle, aria-hidden, sized as asked',
      actual: [
        (html.match(/<rect/g) ?? []).length,
        (html.match(/<circle/g) ?? []).length,
        html.includes('aria-hidden="true"'),
        html.includes('width="24"'),
        html.includes(`rx="${brandMarkGeometry.cornerRadius}"`),
      ],
      expected: [1, 1, true, true, true],
    });
  });

  test('colours each variant from theme tokens only', () => {
    const fills = (['primary', 'mono', 'reverse'] as const).map((variant) =>
      classesOf(renderToString(h(BrandMark, { size: 24, variant }))),
    );
    assert({
      given: 'the primary, mono and reverse variants',
      should:
        'fill the square and disc from the accent, current and stage tokens',
      actual: fills,
      expected: [
        ['fill-accent', 'fill-accent-ink'],
        ['fill-current', 'fill-background'],
        ['fill-stage-accent', 'fill-surface-stage'],
      ],
    });
  });
});

describe('BrandWordmark', () => {
  test('names the product from app config beside the mark', () => {
    const html = renderToString(h(BrandWordmark, {}));
    assert({
      given: 'the wordmark',
      should: 'render the mark and the configured display name',
      actual: [
        html.includes('<svg'),
        // As React escapes it (a display name may hold `&`).
        html.includes(
          renderToString(h(Fragment, null, appConfig.brand.displayName)),
        ),
      ],
      expected: [true, true],
    });
  });
});

describe('brandMarkMarkup', () => {
  test('draws the same geometry as a string for server-rendered pages', () => {
    const markup = brandMarkMarkup({ square: 'a', disc: 'b' });
    const { size, cornerRadius, discRadius } = brandMarkGeometry;
    assert({
      given: 'class names for the two shapes',
      should: 'emit the rect and circle from the shared geometry',
      actual: markup,
      expected: `<rect class="a" width="${size}" height="${size}" rx="${cornerRadius}"></rect><circle class="b" cx="${size / 2}" cy="${size / 2}" r="${discRadius}"></circle>`,
    });
  });
});

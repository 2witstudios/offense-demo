import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  ClearFilters,
  FilterFooter,
  FilterSelect,
  FiltersLabel,
  SearchField,
} from './filter-form';

setupRitewayBun();

describe('filter form parts', () => {
  test('Clear is a link to the cleared URL', () => {
    assert({
      given: 'a clear href',
      should: 'render a Clear link',
      actual: /href="\/projects\?tab=live"[^>]*>Clear</.test(
        renderToString(h(ClearFilters, { href: '/projects?tab=live' })),
      ),
      expected: true,
    });
  });

  test('the footer shows the count, extra controls and a submit Apply', () => {
    const html = renderToString(
      h(FilterFooter, {
        count: 4,
        noun: 'room',
        children: h('span', null, 'extra'),
      }),
    );
    assert({
      given: 'a footer with an extra control',
      should: 'render count, extra and Apply in order',
      actual: [
        html.indexOf('4 rooms') < html.indexOf('extra'),
        html.indexOf('extra') < html.indexOf('Apply'),
        /<button type="submit"[^>]*>Apply</.test(html),
      ],
      expected: [true, true, true],
    });
  });
});

describe('filter controls', () => {
  test('a named select, a search field and the filters count', () => {
    const select = renderToString(
      h(FilterSelect, {
        name: 'sort',
        label: 'Sort by',
        value: 'b',
        options: [
          ['a', 'A'],
          ['b', 'B'],
        ],
      }),
    );
    const search = renderToString(
      h(SearchField, {
        defaultValue: 'cup',
        maxLength: 80,
        placeholder: 'Search',
        label: 'Search things',
      }),
    );
    assert({
      given: 'a select, a search field and two counts of filters',
      should: 'name the controls and show the badge only when something is set',
      actual: [
        /<select name="sort" aria-label="Sort by"/.test(select),
        select.match(/<option/g)?.length,
        /maxlength="80"/i.test(search),
        search.includes('aria-label="Search things"'),
        renderToString(h(FiltersLabel, { active: 2 })).includes('>2<'),
        renderToString(h(FiltersLabel, { active: 0 })).includes(
          'rounded-round',
        ),
      ],
      expected: [true, 2, true, true, true, false],
    });
  });
});

describe('filter form tail details', () => {
  test('Clear renders nothing without a target, and the count pluralizes', () => {
    assert({
      given: 'no clear target and counts of one and two',
      should: 'render nothing for Clear and singular or plural nouns',
      actual: [
        renderToString(h(ClearFilters, { href: null })),
        renderToString(h(FilterFooter, { count: 1, noun: 'room' })).includes(
          '1 room<',
        ),
        renderToString(h(FilterFooter, { count: 2, noun: 'room' })).includes(
          '2 rooms<',
        ),
      ],
      expected: ['', true, true],
    });
  });
});

import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { ProjectList } from './project-list';

setupRitewayBun();

const project = (id: string, name: string, createdAt: string) => ({
  id,
  name,
  createdAt,
});

describe('ProjectList', () => {
  test('renders each project with its name and created date, in the order given', () => {
    const html = renderToString(
      h(ProjectList, {
        projects: [
          project('p2', 'Second launch', '2026-10-05T09:30:00.000Z'),
          project('p1', 'First launch', '2026-01-31T23:59:59.000Z'),
        ],
      }),
    );
    const items = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(
      ([, inner]) => inner ?? '',
    );
    assert({
      given: 'two projects, newest first',
      should:
        'render one list item each, in order, naming the project and its created date as a <time>',
      actual: items.map((inner) => [
        /Second launch|First launch/.exec(inner)?.[0],
        /<time dateTime="([^"]+)">([^<]+)<\/time>/.exec(inner)?.slice(1),
      ]),
      expected: [
        ['Second launch', ['2026-10-05T09:30:00.000Z', 'Oct 5, 2026']],
        ['First launch', ['2026-01-31T23:59:59.000Z', 'Jan 31, 2026']],
      ],
    });
  });

  test('labels the list by its panel heading', () => {
    const html = renderToString(
      h(ProjectList, {
        projects: [project('p1', 'Only', '2026-10-05T00:00:00.000Z')],
      }),
    );
    assert({
      given: 'a list of projects',
      should: 'render it under a "Projects" heading that names the list',
      actual: [
        /<h2[^>]*><span id="projects-heading">Projects<\/span><\/h2>/.test(
          html,
        ),
        /<ul[^>]*aria-labelledby="projects-heading"/.test(html),
      ],
      expected: [true, true],
    });
  });

  test('escapes a project name rather than rendering it as markup', () => {
    const html = renderToString(
      h(ProjectList, {
        projects: [
          project(
            'p1',
            '<img src=x onerror=alert(1)>',
            '2026-10-05T00:00:00.000Z',
          ),
        ],
      }),
    );
    assert({
      given: 'a project name that looks like markup',
      should: 'render it as text',
      actual: [html.includes('<img'), html.includes('&lt;img src=x')],
      expected: [false, true],
    });
  });

  test('renders the empty state when there are no projects', () => {
    const html = renderToString(h(ProjectList, { projects: [] }));
    assert({
      given: 'a member with no projects',
      should: 'render the empty state and no list',
      actual: [html.includes('No projects yet.'), html.includes('<ul')],
      expected: [true, false],
    });
  });
});

import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  CreateProjectForm,
  type CreateProjectFormProps,
} from './create-project-form';

setupRitewayBun();

const render = (overrides: Partial<CreateProjectFormProps> = {}) =>
  renderToString(
    h(CreateProjectForm, {
      name: '',
      pending: false,
      action: () => {},
      ...overrides,
    }),
  );

/** The rendered `<input>` for the project name. */
const nameInput = (html: string) =>
  html.match(/<input[^>]*id="project-name"[^>]*>/)?.[0] ?? '';

describe('CreateProjectForm', () => {
  test('a fresh form labels the field and takes no focus', () => {
    const html = render();
    assert({
      given: 'no answer yet',
      should:
        'label the posted name field, show no notice and leave focus where the reader is',
      actual: [
        html.includes('<label for="project-name"'),
        nameInput(html).includes('name="name"'),
        nameInput(html).includes('autofocus'),
        nameInput(html).includes('aria-invalid="'),
        html.includes('role="alert"'),
      ],
      expected: [true, true, false, false, false],
    });
  });

  test('an invalid name comes back as typed, marked, described and focused', () => {
    const html = render({ name: '   x', notice: 'invalid' });
    assert({
      given: 'a name the server refused as invalid',
      should:
        'start the field from it, mark it invalid, tie the notice to it and focus it without script',
      actual: [
        nameInput(html).includes('value="   x"'),
        nameInput(html).includes('aria-invalid="true"'),
        nameInput(html).includes('aria-describedby="project-name-notice"'),
        nameInput(html).includes('autofocus'),
        html.includes('id="project-name-notice" role="alert"'),
        html.includes('That project name will not work.'),
      ],
      expected: [true, true, true, true, true, true],
    });
  });

  test('a throttled or unavailable create says so and keeps the name', () => {
    const throttled = render({ name: 'Launch', notice: 'rate-limited' });
    const unavailable = render({ name: 'Launch', notice: 'unavailable' });
    assert({
      given: 'the create ceiling, then an unavailable route',
      should:
        'show each notice, keep the typed name and focus the field without marking the name invalid',
      actual: [
        throttled.includes('Too many new projects for now.'),
        unavailable.includes('We could not create your project.'),
        nameInput(throttled).includes('value="Launch"'),
        nameInput(unavailable).includes('autofocus'),
        nameInput(unavailable).includes('aria-invalid="'),
      ],
      expected: [true, true, true, true, false],
    });
  });

  test('a pending create disables the controls', () => {
    const html = render({ pending: true });
    assert({
      given: 'an answer on the way',
      should: 'disable the field and the button and say it is creating',
      actual: [
        nameInput(html).includes('disabled'),
        html.includes('Creating…'),
        html.includes('aria-busy="true"'),
      ],
      expected: [true, true, true],
    });
  });
});

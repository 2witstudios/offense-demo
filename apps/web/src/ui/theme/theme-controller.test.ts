import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createThemeController, createTransition } from './theme-controller';
import type { ThemePreference } from './theme-preference';

setupRitewayBun();

/**
 * Records every side effect in call order; the transition runs inline and
 * the cookie jar is shared, like the tabs of one browser.
 */
const createRecorder = ({
  secure = false,
  jar = { cookies: '' },
  initial = 'dark' as ThemePreference,
} = {}) => {
  const calls: string[] = [];
  const controller = createThemeController({
    initial,
    apply: (preference: ThemePreference) => calls.push(`apply ${preference}`),
    writeCookie: (cookie) => {
      jar.cookies = cookie.split(';')[0] ?? '';
      calls.push(`cookie ${jar.cookies}`);
    },
    readCookies: () => jar.cookies,
    announce: () => calls.push('announce'),
    transition: (update) => {
      calls.push('transition');
      update();
    },
    secure,
  });
  return { calls, controller };
};

describe('createThemeController.select', () => {
  test('persists, applies inside a transition, then tells other tabs', () => {
    const { calls, controller } = createRecorder();
    controller.select('light');

    assert({
      given: 'the viewer choosing light',
      should: 'write the cookie, apply in a transition, and announce',
      actual: calls,
      expected: [
        'cookie offense-demo-theme=light',
        'transition',
        'apply light',
        'announce',
      ],
    });
  });

  test('writes a Secure cookie over https', () => {
    const cookies: string[] = [];
    createThemeController({
      initial: 'dark',
      apply: () => {},
      writeCookie: (cookie) => cookies.push(cookie),
      readCookies: () => '',
      announce: () => {},
      transition: (update) => update(),
      secure: true,
    }).select('system');

    assert({
      given: 'a secure origin',
      should: 'end the cookie with the Secure flag',
      actual: cookies.map((cookie) => cookie.endsWith('; Secure')),
      expected: [true],
    });
  });
});

describe('createThemeController with cookies blocked', () => {
  /** A browser that silently drops cookie writes. */
  const createBlocked = () => {
    const calls: string[] = [];
    const controller = createThemeController({
      initial: 'dark',
      apply: (preference) => calls.push(`apply ${preference}`),
      writeCookie: () => {},
      readCookies: () => '',
      announce: () => calls.push('announce'),
      transition: (update) => update(),
      secure: false,
    });
    return { calls, controller };
  };

  test('keeps a switch for this tab without announcing it', () => {
    const { calls, controller } = createBlocked();
    controller.select('light');

    assert({
      given: 'a switch whose cookie write did not stick',
      should: 'apply it here but not tell tabs that cannot read it',
      actual: calls,
      expected: ['apply light'],
    });
  });

  test('does not revert the switch when the tab is shown again', () => {
    const { calls, controller } = createBlocked();
    controller.select('light');
    const synced = controller.sync();

    assert({
      given: 'a re-sync after an unsaved switch',
      should: 'keep the chosen theme instead of the cookie default',
      actual: { synced, calls },
      expected: { synced: 'light', calls: ['apply light'] },
    });
  });
});

describe('createThemeController.sync', () => {
  test('applies the preference another tab saved', () => {
    const jar = { cookies: 'session=abc; offense-demo-theme=system' };
    const { calls, controller } = createRecorder({ jar });
    const synced = controller.sync();

    assert({
      given: 'another tab announcing a switch to system',
      should: 'apply the cookie value without re-persisting or announcing',
      actual: { synced, calls },
      expected: { synced: 'system', calls: ['transition', 'apply system'] },
    });
  });

  test('never applies a stale choice from a delayed announcement', () => {
    const jar = { cookies: '' };
    const first = createRecorder({ jar });
    const second = createRecorder({ jar });
    first.controller.select('system');
    second.controller.select('light');
    // The first tab's announcement arrives late, after the second's switch.
    const synced = [second.controller.sync(), first.controller.sync()];

    assert({
      given: 'two tabs switching close together, announcements out of order',
      should: 'converge every tab on the last write',
      actual: synced,
      expected: ['light', 'light'],
    });
  });

  test('falls back to the default when the cookie was cleared', () => {
    const { calls, controller } = createRecorder({
      jar: { cookies: 'other=1' },
      initial: 'light',
    });

    assert({
      given: 'a light tab syncing after the theme cookie was cleared',
      should: 'apply the dark default',
      actual: { synced: controller.sync(), calls },
      expected: { synced: 'dark', calls: ['transition', 'apply dark'] },
    });
  });

  test('leaves the page alone when nothing changed', () => {
    const { calls, controller } = createRecorder({
      jar: { cookies: 'offense-demo-theme=light' },
      initial: 'light',
    });
    controller.sync();

    assert({
      given: 'a tab shown again whose theme already matches the cookie',
      should: 'skip the transition and the apply',
      actual: calls,
      expected: [],
    });
  });
});

describe('createTransition', () => {
  test('wraps the update in a view transition when motion is allowed', () => {
    const calls: string[] = [];
    createTransition({
      startViewTransition: (update) => {
        calls.push('view transition');
        update();
      },
      prefersReducedMotion: () => false,
    })(() => calls.push('update'));

    assert({
      given: 'view transition support and no reduced-motion preference',
      should: 'run the update inside the view transition',
      actual: calls,
      expected: ['view transition', 'update'],
    });
  });

  test('updates directly under reduced motion', () => {
    const calls: string[] = [];
    createTransition({
      startViewTransition: () => calls.push('view transition'),
      prefersReducedMotion: () => true,
    })(() => calls.push('update'));

    assert({
      given: 'a reduced-motion preference',
      should: 'skip the view transition',
      actual: calls,
      expected: ['update'],
    });
  });

  test('updates directly without view transition support', () => {
    const calls: string[] = [];
    createTransition({
      startViewTransition: undefined,
      prefersReducedMotion: () => false,
    })(() => calls.push('update'));

    assert({
      given: 'a browser without startViewTransition',
      should: 'run the update directly',
      actual: calls,
      expected: ['update'],
    });
  });
});

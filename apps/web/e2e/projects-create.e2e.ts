import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { resetRateLimits, signUpMember } from './support/accounts';
import { expectFocusOn } from './support/focus';
import { hydrated } from './support/hydration';

/**
 * PROJ-2.3: the `/app` create form is a real POST to a server action that
 * runs POST /api/projects in process. The "with JavaScript off" contexts
 * run no script at all, inline or bundled, so only the browser's own form
 * submission and the server's answer can create, refuse or focus.
 */
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

const listedProjects = (page: Page) =>
  page.getByRole('list', { name: 'Projects' }).getByRole('listitem');

const createProject = async (page: Page, name: string) => {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
};

/** The member's projects as the route itself answers them. */
const storedProjects = async (page: Page) => {
  const response = await page.request.get('/api/projects');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { projects: { name: string }[] }).projects;
};

/**
 * The page is plain `/app` with no query: form values never reach the
 * address bar, history or referrers.
 */
const expectBareAppUrl = (page: Page) => {
  const url = new URL(page.url());
  expect([url.pathname, url.search, url.hash]).toEqual(['/app', '', '']);
};

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('the form creates a project and lands back on /app listing it', async ({
    page,
  }) => {
    await signUpMember(page.request);
    await page.goto('/app');
    await expect(page.getByText('No projects yet.')).toBeVisible();

    const name = 'Spring offensive';
    const posted = page.waitForResponse(
      (response) => response.request().method() === 'POST',
    );
    await createProject(page, name);

    // Post/redirect/get: the browser's own POST answers a 303 back to /app,
    // so a reload never creates the project twice.
    const answer = await posted;
    expect(answer.status()).toBe(303);
    expect(new URL(answer.url()).pathname).toBe('/app');
    await expect(page).toHaveURL(/\/app$/);
    expectBareAppUrl(page);
    await expect(listedProjects(page)).toHaveCount(1);
    await expect(listedProjects(page).first()).toContainText(name);
    // The field starts empty again: the answer was a redirect, not a refusal.
    await expect(page.getByLabel('Project name')).toHaveValue('');
    expect((await storedProjects(page)).map((project) => project.name)).toEqual(
      [name],
    );
  });

  test('an invalid name re-renders /app with the error, focused, and creates nothing', async ({
    page,
  }) => {
    await signUpMember(page.request);
    await page.goto('/app');

    for (const invalid of ['   ', 'x'.repeat(121)]) {
      await createProject(page, invalid);

      await expect(page.locator('#project-name-notice')).toContainText(
        'That project name will not work.',
      );
      const field = page.getByLabel('Project name');
      await expect(field).toHaveValue(invalid);
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expectFocusOn(page, 'input', 'project-name');
      expectBareAppUrl(page);
      await expect(page.getByText('No projects yet.')).toBeVisible();
      expect(await storedProjects(page)).toEqual([]);
    }
  });

  test('the create ceiling comes back as its own notice with the name kept', async ({
    page,
  }) => {
    await signUpMember(page.request);
    await page.goto('/app');
    // ISSUE-3's ceiling: ten creations a minute per member.
    for (let index = 0; index < 10; index += 1) {
      const response = await page.request.post('/api/projects', {
        headers: { origin: new URL(page.url()).origin },
        data: { name: `Quota ${index}` },
      });
      expect(response.status()).toBe(201);
    }

    await createProject(page, 'One too many');

    await expect(page.locator('#project-name-notice')).toContainText(
      'Too many new projects for now.',
    );
    await expect(page.getByLabel('Project name')).toHaveValue('One too many');
    await expectFocusOn(page, 'input', 'project-name');
    expect(await storedProjects(page)).toHaveLength(10);
  });
});

test.describe('with JavaScript on', () => {
  test('the hydrated form creates in place, lists the project and keeps focus on the field', async ({
    page,
  }) => {
    await signUpMember(page.request);
    await page.goto('/app');
    await hydrated(page.getByRole('button', { name: 'Create project' }));

    await createProject(page, 'Hydrated launch');
    await expect(listedProjects(page)).toHaveCount(1);
    await expect(listedProjects(page).first()).toContainText('Hydrated launch');
    await expect(page.getByLabel('Project name')).toHaveValue('');
    await expectFocusOn(page, 'input', 'project-name');

    await createProject(page, '   ');
    await expect(page.locator('#project-name-notice')).toContainText(
      'That project name will not work.',
    );
    await expectFocusOn(page, 'input', 'project-name');

    await createProject(page, 'Second launch');
    await expect(listedProjects(page)).toHaveCount(2);
    await expect(listedProjects(page).first()).toContainText('Second launch');
    await expect(page.locator('#project-name-notice')).toHaveCount(0);
    expect(await storedProjects(page)).toHaveLength(2);
  });
});

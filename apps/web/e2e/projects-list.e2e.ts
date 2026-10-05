import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { origin, resetRateLimits, signUpMember } from './support/accounts';

/**
 * PROJ-2.2: `/app` lists the signed-in member's own projects, read on the
 * server through `readRoute` over GET /api/projects. Every context here
 * runs no script at all, so what the page shows is the server-rendered
 * HTML: a list fetched by client script could not appear.
 */
test.use({ javaScriptEnabled: false });

test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

type Created = { readonly name: string; readonly createdAt: string };

/** Creates a project through the real POST /api/projects as the context's member. */
async function createProject(
  request: APIRequestContext,
  name: string,
): Promise<Created> {
  const response = await request.post('/api/projects', {
    headers: { origin },
    data: { name },
  });
  expect(response.status()).toBe(201);
  const { project } = (await response.json()) as { project: Created };
  return project;
}

/** The date `/app` shows for a project's ISO `createdAt`. */
const shownDate = (createdAt: string) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(createdAt));

const listedProjects = (page: Page) =>
  page.getByRole('list', { name: 'Projects' }).getByRole('listitem');

test('a member sees only their own projects, newest first, with created dates', async ({
  page,
  browser,
}) => {
  await signUpMember(page.request);
  const first = await createProject(page.request, 'Ada first project');
  const second = await createProject(page.request, 'Ada second project');

  const other = await browser.newContext({ javaScriptEnabled: false });
  try {
    await signUpMember(other.request);
    await createProject(other.request, 'Bob private project');
  } finally {
    await other.close();
  }

  await page.goto('/app');
  const items = listedProjects(page);
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(second.name);
  await expect(items.nth(1)).toContainText(first.name);
  for (const [index, project] of [second, first].entries()) {
    const time = items.nth(index).locator('time');
    await expect(time).toHaveAttribute('datetime', project.createdAt);
    await expect(time).toHaveText(shownDate(project.createdAt));
  }
  await expect(page.getByText('Bob private project')).toHaveCount(0);
  await expect(page.getByText('No projects yet.')).toHaveCount(0);
});

test('a member with no projects sees the empty state', async ({ page }) => {
  await signUpMember(page.request);
  await page.goto('/app');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Projects' }),
  ).toBeVisible();
  await expect(page.getByText('No projects yet.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Projects' })).toHaveCount(0);
});

import { expect, test } from './support/fixtures';
import { watchCspViolations } from './support/csp';

test('the home page renders under the production CSP without violations', async ({
  page,
}) => {
  const violations = await watchCspViolations(page);

  await page.goto('/');
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();

  expect(await violations.read()).toEqual({
    eventViolations: [],
    consoleViolations: [],
  });
});

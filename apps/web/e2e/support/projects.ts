import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { origin } from './accounts';

/**
 * Gives the request context's signed-in member one project per name,
 * each through the real POST /api/projects (the route /app reads back),
 * never a seeded row.
 */
export async function givenProjects(
  request: APIRequestContext,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const created = await request.post('/api/projects', {
      headers: { origin },
      data: { name },
    });
    expect(created.status(), `creating project "${name}"`).toBe(201);
  }
}

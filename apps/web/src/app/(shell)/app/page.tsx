import Link from 'next/link';
import type { Metadata } from 'next';
import type { SearchParams } from '../../../features/access/decision';
import { requireAccess } from '../../../lib/access';
import { readRoute } from '../../../lib/request-route';
import { ProjectList } from '../../../ui/projects/project-list';
import { projectListFrom } from '../../../ui/projects/project-list-response';
import { prose } from '../../ui/prose-class';

export const metadata: Metadata = { title: 'App' };

/**
 * The signed-in home (`appConfig.homeRoute`): the member's own projects.
 * `/app` is a participant area, so `requireAccess` sends a visitor to
 * sign-in and an account without a username to onboarding before any read.
 * The list is read on the server through `readRoute` over GET
 * /api/projects, so the route's session and `authorizeRequest` gates decide
 * what the member sees (ADR 0048); the page never queries the database.
 */
export default async function AppHomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const identity = await requireAccess('/app', searchParams);
  const username = identity.state === 'member' ? identity.username : null;
  const projects = await projectListFrom(
    await readRoute((routes) => routes.projects.GET, '/api/projects'),
  );
  return (
    <section className="flex flex-col gap-6 p-10 max-narrow:p-6">
      <h1 className={prose.h1}>
        {username === null
          ? 'You’re signed in'
          : `You’re signed in as ${username}`}
      </h1>
      <ProjectList projects={projects} />
      <p className={prose.p}>
        <Link href="/settings">Settings</Link>
      </p>
    </section>
  );
}

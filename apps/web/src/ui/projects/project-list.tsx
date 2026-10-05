import { Panel } from '../components/panel/panel';
import type { ProjectListItem } from './project-list-response';

/**
 * The created date as one fixed rendering, the same for every viewer and
 * server: the page is rendered on the server, where no viewer locale or
 * time zone is known.
 */
const createdDate = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

/**
 * The member's projects as `/app` shows them: each one's name and created
 * date, in the order the route answered (newest first), or the empty state.
 */
export function ProjectList({
  projects,
}: {
  readonly projects: readonly ProjectListItem[];
}) {
  return (
    <Panel title={<span id="projects-heading">Projects</span>}>
      {projects.length === 0 ? (
        <p className="text-ink-muted">No projects yet.</p>
      ) : (
        <ul aria-labelledby="projects-heading" className="flex flex-col">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-none"
            >
              <span className="font-semibold">{project.name}</span>
              <span className="text-sm text-ink-muted">
                Created{' '}
                <time dateTime={project.createdAt}>
                  {createdDate.format(new Date(project.createdAt))}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

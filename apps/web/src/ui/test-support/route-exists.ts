import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether `href` resolves to a `page.tsx` under the app router tree, given
 * the absolute path of the `app` directory. Route groups (`(name)`) are
 * transparent to the URL, so each segment may also match inside any
 * parenthesized sibling; `[param]` directories match any single segment.
 */
export const routeExists = (appDirectory: string, href: string): boolean => {
  const segments = href.split('/').filter(Boolean);

  const resolve = (
    directory: string,
    remaining: readonly string[],
  ): boolean => {
    if (remaining.length === 0 && existsSync(join(directory, 'page.tsx')))
      return true;
    const entries = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    );
    if (remaining.length === 0)
      return entries.some(
        (entry) =>
          /^\(.*\)$/.test(entry.name) &&
          resolve(join(directory, entry.name), remaining),
      );
    const [segment, ...rest] = remaining;
    return entries.some((entry) => {
      if (/^\(.*\)$/.test(entry.name))
        return resolve(join(directory, entry.name), remaining);
      if (entry.name === segment || entry.name.startsWith('['))
        return resolve(join(directory, entry.name), rest);
      return false;
    });
  };

  return resolve(appDirectory, segments);
};

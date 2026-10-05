// Repository gate for token-locked Tailwind (ADR 0028): styling lives in
// utilities in the markup and in CSS-only theme config, so a CSS Module or a
// JS Tailwind config file must never reappear.

const forbidden: readonly (readonly [RegExp, string])[] = [
  [/\.module\.css$/, 'CSS Modules were replaced by Tailwind utilities'],
  [
    /(^|\/)tailwind\.config\.[cm]?[jt]s$/,
    'Tailwind v4 is configured in CSS (globals.css), not in a config file',
  ],
];

export const stylingIssues = (paths: readonly string[]): readonly string[] =>
  paths.flatMap((path) =>
    forbidden
      .filter(([pattern]) => pattern.test(path))
      .map(([, reason]) => `${path}: ${reason}`),
  );

const trackedAndNew = async (): Promise<readonly string[]> => {
  const listing = Bun.spawnSync([
    'git',
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  return listing.stdout
    .toString()
    .split('\n')
    .filter((path) => path !== '');
};

if (import.meta.main) {
  const issues = stylingIssues(await trackedAndNew());
  for (const issue of issues) console.error(issue);
  process.exitCode = issues.length === 0 ? 0 : 1;
}

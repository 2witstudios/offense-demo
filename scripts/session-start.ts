#!/usr/bin/env bun
/**
 * Session-start check: the main checkout must stay on main, and
 * a session that finds it elsewhere is warned at once instead of a day
 * later. Runs as the committed Claude Code SessionStart hook and as the
 * `checkout` check of bun doctor, which every agent runs.
 */

export function checkoutWarning(input: {
  readonly mainCheckout: boolean;
  readonly branch: string | undefined;
}): string | undefined {
  if (!input.mainCheckout || input.branch === 'main') return undefined;
  return `The main checkout is on ${input.branch ?? 'a detached HEAD'}, not main. It must stay on main: agents never commit, check out or merge there. Move this work to a pu worktree and run \`git switch main\` here.`;
}

export const sessionStartOutput = (warning: string) => ({
  systemMessage: warning,
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: warning,
  },
});

const git = (args: readonly string[], cwd: string): string | undefined => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
};

/** Facts about the checkout containing cwd. */
export function readCheckout(cwd: string) {
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  const commonDir = git(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
  );
  return {
    mainCheckout: gitDir !== undefined && gitDir === commonDir,
    branch: git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd),
  };
}

if (import.meta.main) {
  const warning = checkoutWarning(
    readCheckout(process.env.CLAUDE_PROJECT_DIR ?? process.cwd()),
  );
  if (warning)
    process.stdout.write(`${JSON.stringify(sessionStartOutput(warning))}\n`);
}

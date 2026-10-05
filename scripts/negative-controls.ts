import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

/**
 * AUTH-6.3 AC4: prove that four targeted safeguards actually gate the
 * behavior their tests claim, by sabotaging each one, showing its test
 * fails, restoring the real source, and showing the test passes again. Each
 * control mutates exactly one repository-owned file with a single, exact
 * string replacement (never `sed`/regex) so the sabotage and its restore are
 * a reviewable diff, and only pure, service-free unit tests are used so the
 * whole run needs no live Postgres/Redis.
 */
export type Control = {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly testFile: string;
};

const controls: readonly Control[] = [
  {
    name: 'protected-route session guard',
    file: 'apps/web/src/features/access/decision.ts',
    find: `  if (identity.state === 'anonymous')\n    return redirectTo(signInHref(returnDestination(path)));\n`,
    replace: '',
    testFile: 'apps/web/src/features/access/decision.test.ts',
  },
  {
    name: 'atomic rate limiting replaced with an always-allow adapter',
    file: 'apps/web/src/features/auth/rate-limit.ts',
    find: `const readDecision = (decision: unknown) => {
  if (typeof decision !== 'object' || decision === null)
    throw new TypeError('Malformed limiter decision');
  const allowed: unknown = Reflect.get(decision, 'allowed');
  if (typeof allowed !== 'boolean')
    throw new TypeError('Malformed limiter decision');
  const retryAfterSeconds: unknown = Reflect.get(decision, 'retryAfterSeconds');
  return { allowed, retryAfterSeconds };
};`,
    replace: `const readDecision = (_decision: unknown) => {
  // SABOTAGE: an always-allow adapter, ignoring the real limiter's verdict.
  return { allowed: true, retryAfterSeconds: 0 };
};`,
    testFile: 'apps/web/src/features/auth/rate-limit.test.ts',
  },
  {
    name: 'passkey credential ownership on rename and removal',
    file: 'apps/web/src/features/auth/passkey-ownership-guard.ts',
    // AUTH-6.3.1: Better Auth's own `requireResourceOwnership` (vendored
    // @better-auth/passkey, untracked) also enforces this, but it cannot be
    // sabotaged as a reviewable repo diff. This app-owned guard duplicates
    // the same guarantee ahead of it, so the guarantee has a repo-owned
    // enforcement point to sabotage directly.
    find: `          if (passkey && passkey.userId !== session.user.id)
            throw new APIError('UNAUTHORIZED', {
              code: 'YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY',
            });`,
    replace: `          // SABOTAGE: never refuses a mismatched owner.
          void passkey;`,
    testFile: 'apps/web/src/features/auth/passkey-ownership-guard.test.ts',
  },
  {
    name: 'token replay on an already-consumed emailed-link token',
    file: 'apps/web/src/features/auth/email-change.ts',
    // AUTH-6.3.1 / ISSUE-2: every emailed link (sign-in and email-change) is
    // an opaque, SHA3-hashed, single-use app-owned token. The magic-link
    // sign-in path's redemption is entirely vendored, but the email-change
    // path's `consume` is app-owned and calls the same atomic,
    // delete-on-read `consumeVerificationValue`; swapping it for the
    // non-consuming `findVerificationValue` read permits a replay.
    find: `    const row = await ctx.context.internalAdapter.consumeVerificationValue(
      emailedLinkIdentifier(purpose, token),
    );`,
    replace: `    const row = await ctx.context.internalAdapter.findVerificationValue(
      emailedLinkIdentifier(purpose, token),
    );`,
    testFile: 'apps/web/src/features/auth/email-change.test.ts',
  },
];

const blockedControls: readonly { name: string; reason: string }[] = [];

type RunResult = {
  readonly exitCode: number;
  readonly output: string;
};

type ControlResult = {
  readonly name: string;
  readonly file: string;
  readonly testFile: string;
  readonly diff: string;
  readonly red: RunResult;
  readonly green: RunResult;
  readonly ok: boolean;
};

type NegativeControlsReport = {
  readonly ok: boolean;
  readonly controls: readonly ControlResult[];
  readonly blocked: readonly { name: string; reason: string }[];
};

/** Fails loudly rather than silently no-op'ing if the source has drifted. */
export function applyMutation(content: string, control: Control): string {
  const occurrences = content.split(control.find).length - 1;
  if (occurrences !== 1)
    throw new Error(
      `${control.name}: expected exactly one occurrence of the target text in ${control.file}, found ${occurrences}. The source has drifted; update the control.`,
    );
  return content.replace(control.find, control.replace);
}

export function formatReport(report: NegativeControlsReport): string {
  const lines: string[] = [
    `# Negative controls — AUTH-6.3 AC4`,
    '',
    `Overall: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
  ];
  for (const result of report.controls) {
    lines.push(
      `## ${result.name}`,
      '',
      `File: \`${result.file}\``,
      `Test: \`${result.testFile}\``,
      `Result: ${result.ok ? 'PASS (red then green, as required)' : 'FAIL'}`,
      '',
      '```diff',
      result.diff.trim(),
      '```',
      '',
      `Sabotaged run (expected FAIL) — exit ${result.red.exitCode}:`,
      '```',
      result.red.output.trim(),
      '```',
      '',
      `Restored run (expected PASS) — exit ${result.green.exitCode}:`,
      '```',
      result.green.output.trim(),
      '```',
      '',
    );
  }
  if (report.blocked.length > 0) {
    lines.push('## Not sabotaged (vendor-enforced, see reasons)', '');
    for (const blocked of report.blocked)
      lines.push(`- **${blocked.name}**: ${blocked.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

function runGit(args: readonly string[]): RunResult {
  const result = Bun.spawnSync(['git', ...args], { cwd: root });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr}`,
  };
}

function runTest(testFile: string): RunResult {
  const result = Bun.spawnSync(['bun', 'test', testFile], { cwd: root });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr}`,
  };
}

function assertCleanTree(): void {
  const status = runGit(['status', '--porcelain']);
  if (status.output.trim() !== '')
    throw new Error(
      'The working tree is not clean. Negative controls sabotage and restore real source files via `git checkout --`; refusing to run against uncommitted work:\n' +
        status.output,
    );
}

async function runControl(control: Control): Promise<ControlResult> {
  const path = resolve(root, control.file);
  const original = readFileSync(path, 'utf8');
  const mutated = applyMutation(original, control);
  writeFileSync(path, mutated);
  const diff = runGit(['diff', '--', control.file]).output;
  const red = runTest(control.testFile);
  // Restore via git, never by re-writing the buffer: proves the working
  // tree is byte-identical to the committed source afterward.
  const restore = runGit(['checkout', '--', control.file]);
  if (restore.exitCode !== 0)
    throw new Error(`Failed to restore ${control.file}: ${restore.output}`);
  const clean = runGit(['diff', '--', control.file]).output.trim();
  if (clean !== '') throw new Error(`${control.file} did not restore cleanly`);
  const green = runTest(control.testFile);
  return {
    name: control.name,
    file: control.file,
    testFile: control.testFile,
    diff,
    red,
    green,
    // The control is proven only if sabotage genuinely broke the test AND
    // the restored source genuinely passes it again.
    ok: red.exitCode !== 0 && green.exitCode === 0,
  };
}

async function runAllControls(): Promise<NegativeControlsReport> {
  assertCleanTree();
  const results: ControlResult[] = [];
  for (const control of controls) results.push(await runControl(control));
  assertCleanTree();
  return {
    ok: results.every((result) => result.ok),
    controls: results,
    blocked: blockedControls,
  };
}

if (import.meta.main) {
  const report = await runAllControls();
  const outDir = resolve(root, 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, 'negative-controls-report.json'),
    JSON.stringify(report, null, 2),
  );
  const markdown = formatReport(report);
  writeFileSync(resolve(outDir, 'negative-controls-report.md'), markdown);
  process.stdout.write(markdown);
  process.exitCode = report.ok ? 0 : 1;
}

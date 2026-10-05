#!/usr/bin/env bun
/**
 * ADR numbers are claimed by open branches before they merge, so two
 * parallel PRs can take the same number and merge without a git conflict
 *. `bun adr:next` prints the number free across origin/main and
 * every open PR; `bun policy` fails a branch whose number an earlier-opened
 * PR already holds. Migrations carry no number to claim: drizzle-kit 1.0
 * names each folder by its generation timestamp (ADR 0038), and
 * `bun migrations:check` fails a branch whose migrations do not append to
 * main's.
 */

export type Kind = 'ADR';
export type Claim = {
  readonly kind: Kind;
  readonly number: string;
  readonly file: string;
};
export type OpenPr = {
  readonly number: number;
  readonly branch: string;
  readonly files: readonly string[];
};

const patterns: readonly (readonly [Kind, RegExp])[] = [
  ['ADR', /^docs\/decisions\/(\d{4})-[^/]+\.md$/],
];

export function claimsOf(files: readonly string[]): readonly Claim[] {
  return files.flatMap((file) =>
    patterns.flatMap(([kind, pattern]) => {
      const number = pattern.exec(file)?.[1];
      return number === undefined ? [] : [{ kind, number, file }];
    }),
  );
}

/**
 * ADR numbers the decisions index reserves under "Intentionally absent
 * numbers": records removed on purpose, never to be reused. Pure: callers
 * read docs/decisions/README.md.
 */
export function reservedAdrClaims(index: string): readonly Claim[] {
  const section = /## Intentionally absent numbers\n([\s\S]*?)(?:\n## |$)/.exec(
    index,
  );
  return [...(section?.[1] ?? '').matchAll(/\b\d{4}\b/g)].map(([number]) => ({
    kind: 'ADR' as const,
    number,
    file: 'docs/decisions/README.md',
  }));
}

export function nextFree(claims: readonly Claim[], kind: Kind): string {
  const numbers = claims
    .filter((claim) => claim.kind === kind)
    .map((claim) => Number(claim.number));
  return String(Math.max(-1, ...numbers) + 1).padStart(4, '0');
}

/**
 * Clashes between this branch's claims and open PRs. With a PR number only
 * earlier-opened PRs count, because the earlier PR keeps the number.
 */
export function collisionProblems(
  openPrs: readonly OpenPr[],
  ownPr: number | undefined,
  ownFiles?: readonly string[],
): readonly string[] {
  const own = claimsOf(
    ownFiles ?? openPrs.find((pr) => pr.number === ownPr)?.files ?? [],
  );
  const others = openPrs.filter(
    (pr) => pr.number !== ownPr && (ownPr === undefined || pr.number < ownPr),
  );
  return own.flatMap((claim) =>
    others.flatMap((pr) =>
      claimsOf(pr.files)
        .filter(
          (theirs) =>
            theirs.kind === claim.kind &&
            theirs.number === claim.number &&
            theirs.file !== claim.file,
        )
        .map(
          (theirs) =>
            `numbers: ${claim.kind} ${claim.number} (${claim.file}) is already claimed by open PR #${pr.number} (${theirs.file}); run bun adr:next`,
        ),
    ),
  );
}

// ------------------------------------------------------------------- edges

type Run = (args: readonly string[]) => {
  readonly code: number;
  readonly stdout: string;
};

const spawnRun: Run = (args) => {
  const result = Bun.spawnSync([...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, stdout: result.stdout.toString() };
};

/** Open PRs with their files; throws when GitHub cannot be read. */
export function listOpenPrs(run: Run = spawnRun): readonly OpenPr[] {
  const result = run([
    'gh',
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,headRefName,files',
  ]);
  if (result.code !== 0)
    throw new Error(
      'numbers: cannot list open PRs with gh (authenticate gh, or set GH_TOKEN in CI)',
    );
  return (
    JSON.parse(result.stdout) as {
      number: number;
      headRefName: string;
      files: { path: string }[];
    }[]
  ).map((pr) => ({
    number: pr.number,
    branch: pr.headRefName,
    files: pr.files.map((file) => file.path),
  }));
}

const lines = (text: string) => text.split('\n').filter(Boolean);

type Env = Readonly<Record<string, string | undefined>>;

/** This branch's PR number, or its added files when it has no PR yet. */
function ownBranch(run: Run, openPrs: readonly OpenPr[], env: Env) {
  const ciPr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1];
  if (ciPr) return { pr: Number(ciPr), files: undefined };
  const branch = run([
    'git',
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]).stdout.trim();
  const pr = openPrs.find((candidate) => candidate.branch === branch)?.number;
  const added = run([
    'git',
    'diff',
    '--name-only',
    '--diff-filter=A',
    'origin/main...HEAD',
  ]);
  // Without the diff this branch's claims are unknown: fail, never pass.
  if (added.code !== 0)
    throw new Error(
      'numbers: cannot diff this branch against origin/main (git fetch origin, then retry)',
    );
  return { pr, files: lines(added.stdout) };
}

export function numberCollisionProblems(
  run: Run = spawnRun,
  env: Env = process.env,
): readonly string[] {
  try {
    const openPrs = listOpenPrs(run);
    const own = ownBranch(run, openPrs, env);
    return collisionProblems(openPrs, own.pr, own.files);
  } catch (error) {
    return [(error as Error).message];
  }
}

if (import.meta.main) {
  const main = spawnRun(['git', 'ls-tree', '-r', '--name-only', 'origin/main']);
  const local = spawnRun(['git', 'ls-files']);
  const claims = [
    ...claimsOf(lines(main.stdout)),
    ...claimsOf(lines(local.stdout)),
    ...listOpenPrs().flatMap((pr) => claimsOf(pr.files)),
    ...reservedAdrClaims(
      await Bun.file('docs/decisions/README.md')
        .text()
        .catch(() => ''),
    ),
  ];
  process.stdout.write(`next ADR: ${nextFree(claims, 'ADR')}\n`);
}

#!/usr/bin/env bun
/**
 * Decides whether deploy-staging ships a main commit (ISSUE-51, owner
 * decision 2026-09-23): staging deploys when the CI gate job is green and
 * the Browser E2E run is green. The gate needs every CI job, the
 * dependency audit included (ADR 0039), so a new advisory holds staging
 * back.
 *
 *   bun scripts/staging-gate.ts --sha <commit> --trigger <CI|Browser E2E>
 *
 * Both workflows trigger deploy-staging on completion. The one that
 * completes last decides (a tie goes to CI), so a commit ships once, and
 * only while it is still main's tip: a later re-run of an older commit's
 * CI or E2E never rolls staging back (ISSUE-59). Writes
 * `deploy=true|false` to $GITHUB_OUTPUT when set, and the reason to stdout.
 */
import { appendFileSync } from 'node:fs';

type Trigger = 'CI' | 'Browser E2E';
type Status = string;
type Conclusion = string | null;

export type StagingEvidence = {
  readonly trigger: Trigger;
  /** The commit the triggering run verified. */
  readonly sha: string;
  /** main's head when the decision is made. */
  readonly mainTip: string;
  readonly ci?: {
    readonly status: Status;
    readonly gate: Conclusion;
    readonly completedAt: string | null;
  };
  readonly e2e?: {
    readonly status: Status;
    readonly conclusion: Conclusion;
    readonly completedAt: string | null;
  };
};

export type StagingDecision = {
  readonly deploy: boolean;
  readonly reason: string;
};

const GATE_JOB = 'CI gate';
const CI_PATH = '.github/workflows/ci.yml';
const E2E_PATH = '.github/workflows/e2e.yml';

export function stagingDecision(evidence: StagingEvidence): StagingDecision {
  const { ci, e2e, trigger, sha, mainTip } = evidence;
  if (sha !== mainTip)
    return {
      deploy: false,
      reason: `${sha} is no longer main's tip (${mainTip})`,
    };
  if (!ci) return { deploy: false, reason: 'no CI run for this commit' };
  if (!e2e)
    return { deploy: false, reason: 'no Browser E2E run for this commit' };
  if (ci.status !== 'completed')
    return {
      deploy: false,
      reason: 'CI has not completed; its completion decides',
    };
  if (e2e.status !== 'completed')
    return {
      deploy: false,
      reason: 'Browser E2E has not completed; its completion decides',
    };
  if (ci.gate !== 'success')
    return { deploy: false, reason: `the CI gate ended ${ci.gate ?? 'unrun'}` };
  if (e2e.conclusion !== 'success')
    return {
      deploy: false,
      reason: `Browser E2E ended ${e2e.conclusion ?? 'without a conclusion'}`,
    };
  const later: Trigger =
    (e2e.completedAt ?? '') > (ci.completedAt ?? '') ? 'Browser E2E' : 'CI';
  if (trigger !== later)
    return {
      deploy: false,
      reason: `both green; the later completion (${later}) deploys`,
    };
  return { deploy: true, reason: 'the CI gate and Browser E2E are green' };
}

type Run = {
  readonly id: number;
  readonly path: string;
  readonly status: Status;
  readonly conclusion: Conclusion;
  readonly updated_at: string;
};

/** Reads the newest main push run of each workflow and the CI gate's verdict. */
export function readStagingEvidence(
  api: (path: string) => unknown,
  input: {
    readonly repository: string;
    readonly sha: string;
    readonly trigger: Trigger;
  },
): StagingEvidence {
  const { sha: mainTip } = api(`repos/${input.repository}/commits/main`) as {
    readonly sha: string;
  };
  const base = `repos/${input.repository}/actions/runs`;
  const { workflow_runs: runs } = api(
    `${base}?head_sha=${input.sha}&event=push&branch=main&per_page=100`,
  ) as { readonly workflow_runs: readonly Run[] };
  const newest = (path: string) =>
    runs
      .filter((run) => run.path === path)
      .reduce<Run | undefined>(
        (best, run) => (best && best.id > run.id ? best : run),
        undefined,
      );
  const ciRun = newest(CI_PATH);
  const e2eRun = newest(E2E_PATH);
  const completedAt = (run: Run) =>
    run.status === 'completed' ? run.updated_at : null;
  const gate = () => {
    const { jobs } = api(
      `${base}/${ciRun?.id}/jobs?filter=latest&per_page=100`,
    ) as {
      readonly jobs: readonly {
        readonly name: string;
        readonly conclusion: Conclusion;
      }[];
    };
    return jobs.find((job) => job.name === GATE_JOB)?.conclusion ?? null;
  };
  return {
    trigger: input.trigger,
    sha: input.sha,
    mainTip,
    ...(ciRun && {
      ci: {
        status: ciRun.status,
        gate: ciRun.status === 'completed' ? gate() : null,
        completedAt: completedAt(ciRun),
      },
    }),
    ...(e2eRun && {
      e2e: {
        status: e2eRun.status,
        conclusion: e2eRun.conclusion,
        completedAt: completedAt(e2eRun),
      },
    }),
  };
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (import.meta.main) {
  const sha = argument('--sha');
  const trigger = argument('--trigger');
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    !sha ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    (trigger !== 'CI' && trigger !== 'Browser E2E') ||
    !repository
  ) {
    process.stderr.write(
      'usage: GITHUB_REPOSITORY=<owner/repo> bun scripts/staging-gate.ts --sha <40-hex commit> --trigger <CI|Browser E2E>\n',
    );
    process.exit(2);
  }
  const api = (path: string): unknown => {
    const result = Bun.spawnSync(['gh', 'api', path], {
      stdout: 'pipe',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0)
      throw new Error(`gh api ${path} exited ${result.exitCode}`);
    return JSON.parse(result.stdout.toString());
  };
  const decision = stagingDecision(
    readStagingEvidence(api, { repository, sha, trigger }),
  );
  process.stdout.write(`${decision.reason}\n`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `deploy=${decision.deploy}\n`);
}

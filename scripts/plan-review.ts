#!/usr/bin/env bun
/**
 * `bun plan:review <planPageId>`: the automated external plan
 * review of the epic pipeline. Codex reads the plan with AGENTS.md and the
 * accepted ADRs in hand, before any tasking, so a plan that contradicts a
 * decision (a backfill under ADR 0023, UUIDs under ADR 0018) is caught
 * before builders fan out. Prints the review; the epic-pipeline skill
 * publishes it and stops for owner approval.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Adr = {
  readonly number: string;
  readonly title: string;
  /** A later ADR replaced it: listed so a plan citing it is caught. */
  readonly superseded?: boolean;
};

type AdrFile = {
  readonly file: string;
  readonly firstLine: string;
  /** The record's "Status:" line, when it has one. */
  readonly status?: string;
};

/** A decision record's file name, heading line and status line. */
export function adrFile(dir: string, file: string): AdrFile {
  const lines = readFileSync(join(dir, file), 'utf8').split('\n');
  return {
    file,
    firstLine: lines[0] ?? '',
    status: lines.find((line) => /^Status:/i.test(line)),
  };
}

/**
 * Every decision record, numbered by its file name. The title comes from a
 * "# 0023: …" or "# ADR 0001: …" heading, or else from the file name, so
 * no record is left out of the review.
 */
export function adrIndex(files: readonly AdrFile[]): readonly Adr[] {
  return files
    .flatMap(({ file, firstLine, status }) => {
      const named = /^(\d{4})-(.+)\.md$/.exec(file);
      if (!named) return [];
      const heading = /^#\s*(?:ADR\s+)?\d{4}:\s*(.+)$/.exec(firstLine.trim());
      const title = heading?.[1] ?? named[2].replaceAll('-', ' ');
      const superseded = /^Status:\s*superseded/i.test(status ?? '');
      return [{ number: named[1], title, superseded }];
    })
    .sort((a, b) => a.number.localeCompare(b.number));
}

export function planReviewPrompt(input: {
  readonly agents: string;
  readonly adrs: readonly Adr[];
  readonly plan: string;
}): string {
  return [
    'You are an external reviewer of an implementation plan for this repository, before any of it is tasked. You do not edit anything.',
    'Review the plan against the repository contract (AGENTS.md) and the accepted decisions (docs/decisions). Read any ADR in full when the plan touches it.',
    'Report, each with severity (blocker, major, minor), the plan section and the AGENTS.md rule or ADR it concerns:',
    '- anything that contradicts AGENTS.md or an accepted ADR (for example a backfill, compat path or legacy mode under the greenfield baseline, or UUIDs where cuid2 is decided);',
    '- terms or approaches a later ADR superseded;',
    '- work that depends on a decision, contract or prerequisite that is not merged, and leaves that must be sequenced rather than run in parallel;',
    '- ADR or migration numbers the plan claims (they come from bun adr:next at the time, not the plan);',
    '- acceptance criteria that are ambiguous, untestable or cannot be proven by a test that fails when the behaviour is removed.',
    'End with exactly one line: "PLAN REVIEW: APPROVE" or "PLAN REVIEW: CHANGES REQUESTED".',
    '',
    '## AGENTS.md',
    input.agents,
    '',
    '## Decisions (superseded ones are marked and are not in force)',
    ...input.adrs.map(
      (adr) =>
        `ADR ${adr.number}: ${adr.title}${adr.superseded ? ' (superseded: not in force)' : ''}`,
    ),
    '',
    '## Plan',
    input.plan,
  ].join('\n');
}

/** The last line that is exactly a verdict; a verdict quoted in prose never counts. */
export function parseVerdict(
  output: string,
): 'APPROVE' | 'CHANGES REQUESTED' | undefined {
  const verdict = output
    .split('\n')
    .map(
      (line) =>
        /^PLAN REVIEW: (APPROVE|CHANGES REQUESTED)$/.exec(line.trim())?.[1],
    )
    .findLast((match) => match !== undefined);
  return verdict as 'APPROVE' | 'CHANGES REQUESTED' | undefined;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [planId] = process.argv.slice(2);
  if (!planId || !/^[a-z0-9]{20,32}$/.test(planId)) {
    process.stderr.write('usage: bun plan:review <planPageId>\n');
    process.exit(2);
  }
  const plan = Bun.spawnSync(['pagespace', 'pages', 'read', planId, '--json'], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (plan.exitCode !== 0) process.exit(1);
  const decisions = join(root, 'docs/decisions');
  const prompt = planReviewPrompt({
    agents: readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    adrs: adrIndex(
      readdirSync(decisions).map((file) => adrFile(decisions, file)),
    ),
    plan:
      (JSON.parse(plan.stdout.toString()) as { content?: string }).content ??
      '',
  });
  const out = join(
    process.env.TMPDIR ?? '/tmp',
    `plan-review-${planId}-${process.pid}.md`,
  );
  const codex = Bun.spawnSync(
    ['codex', 'exec', '--sandbox', 'read-only', '--cd', root, '-o', out, '-'],
    { stdin: Buffer.from(prompt), stdout: 'ignore', stderr: 'inherit' },
  );
  const review = codex.exitCode === 0 ? readFileSync(out, 'utf8') : '';
  rmSync(out, { force: true });
  process.stdout.write(review);
  const verdict = parseVerdict(review);
  process.stderr.write(
    `plan review: ${verdict ?? 'NO VERDICT (treat as not reviewed)'}\n`,
  );
  process.exit(verdict ? 0 : 1);
}

#!/usr/bin/env bun
import {
  FINDING_SEVERITIES,
  parseDocumentationEvent,
  RUN_RECORD_STATUSES,
  type FindingSeverity,
  type RunRecordStatus,
} from './docs-contracts';
import type { ChangeKind, DocumentPipeline } from './docs-pipeline';
import type { TextRisk } from './untrusted-text';

export type PublicationDecision = 'publish' | 'revision' | 'review' | 'block';

export type PublicationApprovals = {
  readonly human?: { readonly by: string; readonly at: string };
  readonly blog?: { readonly by: string; readonly at: string };
};

const isValidApproval = (
  approval: PublicationApprovals['human'],
): approval is { readonly by: string; readonly at: string } =>
  approval !== undefined &&
  typeof approval.by === 'string' &&
  approval.by.length > 0 &&
  typeof approval.at === 'string' &&
  !Number.isNaN(Date.parse(approval.at));

export function publicationDecision(input: {
  readonly changeKind: ChangeKind;
  readonly pipelines: readonly DocumentPipeline[];
  readonly findings: readonly FindingSeverity[];
  readonly runStatus: RunRecordStatus;
  readonly textRisk: TextRisk;
  readonly approvals?: PublicationApprovals;
}): {
  readonly decision: PublicationDecision;
  readonly reasons: readonly string[];
} {
  const reasons: string[] = [];
  if (input.runStatus !== 'complete') {
    reasons.push(
      `the run did not complete (status ${input.runStatus}); edits are held for review`,
    );
    return { decision: 'review', reasons };
  }
  if (input.findings.includes('blocker')) {
    reasons.push('a blocker finding invalidates the page');
    return { decision: 'block', reasons };
  }
  if (input.findings.includes('major')) {
    reasons.push('a major finding marks the page stale for review');
    return { decision: 'review', reasons };
  }
  if (input.textRisk === 'flagged') {
    reasons.push(
      'the event text matched an injection pattern; a human must review the candidate',
    );
    return { decision: 'review', reasons };
  }
  if (input.pipelines.includes('blog')) {
    if (isValidApproval(input.approvals?.blog)) {
      reasons.push(`blog publication approved by ${input.approvals.blog.by}`);
    } else {
      reasons.push('blog revisions remain drafts without explicit approval');
      return { decision: 'revision', reasons };
    }
  }
  if (
    (input.changeKind === 'breaking' || input.changeKind === 'security') &&
    !input.pipelines.includes('blog')
  ) {
    if (isValidApproval(input.approvals?.human)) {
      reasons.push(
        `${input.changeKind} publication approved by ${input.approvals.human.by}`,
      );
    } else {
      reasons.push(
        `${input.changeKind} changes require recorded human sign-off before publication`,
      );
      return { decision: 'review', reasons };
    }
  }
  if (
    input.findings.includes('minor') ||
    input.findings.includes('editorial')
  ) {
    reasons.push('minor or editorial findings batch into a review revision');
    return { decision: 'revision', reasons };
  }
  reasons.push('no gating condition applied');
  return { decision: 'publish', reasons };
}

export function canApplyRevision(input: {
  readonly expectedRevision: string | undefined;
  readonly currentRevision: string;
}): boolean {
  return (
    input.expectedRevision !== undefined &&
    input.expectedRevision === input.currentRevision
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseApprovals(value: unknown): PublicationApprovals {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('approvals must be an object');
  const approvals: {
    human?: { by: string; at: string };
    blog?: { by: string; at: string };
  } = {};
  for (const kind of ['human', 'blog'] as const) {
    const entry = value[kind];
    if (entry === undefined || entry === null) continue;
    if (
      !isRecord(entry) ||
      typeof entry.by !== 'string' ||
      typeof entry.at !== 'string'
    )
      throw new Error(`approvals.${kind} must be { by, at }`);
    approvals[kind] = { by: entry.by, at: entry.at };
  }
  return approvals;
}

async function main(): Promise<void> {
  const raw = JSON.parse(await new Response(Bun.stdin.stream()).text());
  if (!isRecord(raw)) throw new Error('candidate must be a JSON object');
  const event = parseDocumentationEvent(raw.event);
  const textRisk = event.textRisk ?? 'flagged';
  const runStatus =
    raw.runStatus === undefined
      ? 'complete'
      : (raw.runStatus as RunRecordStatus);
  if (!RUN_RECORD_STATUSES.includes(runStatus))
    throw new Error(
      `runStatus must be one of ${RUN_RECORD_STATUSES.join(', ')}`,
    );
  const findings = (raw.findings ?? []) as FindingSeverity[];
  if (
    !Array.isArray(findings) ||
    !findings.every((severity) => FINDING_SEVERITIES.includes(severity))
  )
    throw new Error(
      `findings must be a subset of ${FINDING_SEVERITIES.join(', ')}`,
    );
  const decision = publicationDecision({
    changeKind: event.classification.changeKind,
    pipelines: event.classification.pipelines,
    findings,
    runStatus,
    textRisk,
    approvals: parseApprovals(raw.approvals),
  });
  process.stdout.write(
    `${JSON.stringify({ idempotencyKey: event.idempotencyKey, ...decision }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  await main();
}

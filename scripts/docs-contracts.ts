import {
  CHANGE_KINDS,
  DOCUMENT_EVENT_TYPES,
  DOCUMENT_EVENT_VERSION,
  DOCUMENT_PIPELINES,
  type ChangeKind,
  type DocumentEventType,
  type DocumentPipeline,
  type DocumentationEvent,
} from './docs-pipeline';
import { TEXT_RISKS, type TextRisk } from './untrusted-text';

type Problems = { readonly path: string; readonly problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.length > 0;

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const readPath = (container: Record<string, unknown>, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, segment) => (isRecord(node) ? node[segment] : undefined),
      container,
    );

function checkString(
  problems: Problems[],
  container: Record<string, unknown>,
  path: string,
): void {
  if (!isNonEmptyString(readPath(container, path)))
    problems.push({ path, problem: 'must be a non-empty string' });
}

function checkOptionalString(
  problems: Problems[],
  container: Record<string, unknown>,
  path: string,
): void {
  const value = readPath(container, path);
  if (value !== null && value !== undefined && !isString(value))
    problems.push({ path, problem: 'must be a string or null' });
}

// For fields typed `?: string`: absent is fine, null is not, so the parsed
// value always matches its declared type.
function checkAbsentOrString(
  problems: Problems[],
  container: Record<string, unknown>,
  path: string,
): void {
  const value = readPath(container, path);
  if (value !== undefined && !isString(value))
    problems.push({ path, problem: 'must be a string or absent' });
}

function checkStringArray(
  problems: Problems[],
  container: Record<string, unknown>,
  path: string,
): void {
  const value = readPath(container, path);
  if (!Array.isArray(value) || !value.every(isString))
    problems.push({ path, problem: 'must be an array of strings' });
}

function checkOptionalStringArray(
  problems: Problems[],
  container: Record<string, unknown>,
  path: string,
): void {
  const value = readPath(container, path);
  if (value !== null && value !== undefined && !Array.isArray(value))
    problems.push({ path, problem: 'must be an array of strings or absent' });
}

function fail(problems: readonly Problems[]): never {
  throw new Error(
    `Invalid documentation payload: ${problems
      .map(({ path, problem }) => `${path} ${problem}`)
      .join('; ')}`,
  );
}

const pullRequestProblems = (
  root: Record<string, unknown>,
): readonly Problems[] => {
  const pullRequest = root.pullRequest;
  if (!isRecord(pullRequest)) return [];
  const problems: Problems[] = [];
  if (!Number.isInteger(pullRequest.number))
    problems.push({
      path: 'pullRequest.number',
      problem: 'must be an integer',
    });
  checkString(problems, root, 'pullRequest.title');
  checkOptionalString(problems, root, 'pullRequest.body');
  checkString(problems, root, 'pullRequest.url');
  checkOptionalString(problems, root, 'pullRequest.author');
  checkOptionalString(problems, root, 'pullRequest.mergedBy');
  return problems;
};

const classificationProblems = (
  root: Record<string, unknown>,
): readonly Problems[] => {
  const classification = root.classification;
  if (!isRecord(classification)) return [];
  const problems: Problems[] = [];
  if (
    !isString(classification.changeKind) ||
    !CHANGE_KINDS.includes(classification.changeKind as ChangeKind)
  )
    problems.push({
      path: 'classification.changeKind',
      problem: `must be one of ${CHANGE_KINDS.join(', ')}`,
    });
  if (
    !Array.isArray(classification.pipelines) ||
    !classification.pipelines.every(
      (pipeline) =>
        isString(pipeline) &&
        DOCUMENT_PIPELINES.includes(pipeline as DocumentPipeline),
    )
  )
    problems.push({
      path: 'classification.pipelines',
      problem: `must be a subset of ${DOCUMENT_PIPELINES.join(', ')}`,
    });
  checkStringArray(problems, root, 'classification.reasons');
  return problems;
};

export function parseDocumentationEvent(raw: unknown): DocumentationEvent {
  if (!isRecord(raw)) fail([{ path: 'event', problem: 'must be an object' }]);
  const problems: Problems[] = [];
  if (raw.eventVersion !== DOCUMENT_EVENT_VERSION)
    problems.push({
      path: 'eventVersion',
      problem: `must be "${DOCUMENT_EVENT_VERSION}"`,
    });
  if (!DOCUMENT_EVENT_TYPES.includes(raw.eventType as DocumentEventType))
    problems.push({
      path: 'eventType',
      problem: `must be one of ${DOCUMENT_EVENT_TYPES.join(', ')}`,
    });
  checkString(problems, raw, 'eventId');
  checkString(problems, raw, 'occurredAt');
  checkString(problems, raw, 'repository');
  checkString(problems, raw, 'baseRef');
  checkString(problems, raw, 'commit');
  checkString(problems, raw, 'idempotencyKey');
  checkStringArray(problems, raw, 'taskIds');
  checkStringArray(problems, raw, 'changedFiles');
  checkStringArray(problems, raw, 'sourceRefs');
  checkAbsentOrString(problems, raw, 'promptVersion');
  if (
    raw.textRisk !== null &&
    raw.textRisk !== undefined &&
    !TEXT_RISKS.includes(raw.textRisk as TextRisk)
  )
    problems.push({
      path: 'textRisk',
      problem: `must be one of ${TEXT_RISKS.join(', ')}`,
    });
  checkOptionalStringArray(problems, raw, 'textRiskReasons');
  if (raw.pullRequest !== null && !isRecord(raw.pullRequest))
    problems.push({
      path: 'pullRequest',
      problem: 'must be an object or null',
    });
  else if (isRecord(raw.pullRequest))
    problems.push(...pullRequestProblems(raw));
  if (!isRecord(raw.classification))
    problems.push({ path: 'classification', problem: 'must be an object' });
  else problems.push(...classificationProblems(raw));
  if (problems.length > 0) fail(problems);
  return raw as unknown as DocumentationEvent;
}

export const RUN_RECORD_STATUSES = ['complete', 'failed', 'partial'] as const;
export type RunRecordStatus = (typeof RUN_RECORD_STATUSES)[number];

export const FINDING_SEVERITIES = [
  'blocker',
  'major',
  'minor',
  'editorial',
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

type DocumentationFinding = {
  readonly pageId: string;
  readonly sectionId: string;
  readonly claim: string;
  readonly sourceChecked: string;
  readonly currentEvidence: string;
  readonly severity: FindingSeverity;
  readonly recommendedAction: string;
};

export type DocumentationRunRecord = {
  readonly runId: string;
  readonly workflow: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scope: {
    readonly pageIds: readonly string[];
    readonly changedSince: string;
  };
  readonly pagesReviewed: number;
  readonly findings: readonly DocumentationFinding[];
  readonly autoFixed: number;
  readonly tasksCreated: number;
  readonly pagesInvalidated: number;
  readonly promptVersion: string;
  readonly sourceSnapshot: string;
  readonly status: RunRecordStatus;
  readonly baseRevision?: string;
  readonly resultingRevision?: string;
  readonly idempotencyKey?: string;
  readonly notes?: string;
};

const findingProblems = (
  finding: Record<string, unknown>,
  index: number,
): readonly Problems[] => {
  const problems: Problems[] = [];
  for (const field of [
    'pageId',
    'sectionId',
    'claim',
    'sourceChecked',
    'currentEvidence',
    'recommendedAction',
  ] as const)
    if (!isNonEmptyString(finding[field]))
      problems.push({
        path: `findings[${index}].${field}`,
        problem: 'must be a non-empty string',
      });
  if (
    !isString(finding.severity) ||
    !FINDING_SEVERITIES.includes(finding.severity as FindingSeverity)
  )
    problems.push({
      path: `findings[${index}].severity`,
      problem: `must be one of ${FINDING_SEVERITIES.join(', ')}`,
    });
  return problems;
};

export function parseRunRecord(raw: unknown): DocumentationRunRecord {
  if (!isRecord(raw))
    fail([{ path: 'runRecord', problem: 'must be an object' }]);
  const problems: Problems[] = [];
  for (const field of [
    'runId',
    'workflow',
    'startedAt',
    'completedAt',
    'promptVersion',
    'sourceSnapshot',
  ] as const)
    checkString(problems, raw, field);
  for (const field of [
    'baseRevision',
    'resultingRevision',
    'idempotencyKey',
    'notes',
  ] as const)
    checkAbsentOrString(problems, raw, field);
  if (!isRecord(raw.scope))
    problems.push({ path: 'scope', problem: 'must be an object' });
  else {
    checkStringArray(problems, raw, 'scope.pageIds');
    checkString(problems, raw, 'scope.changedSince');
  }
  for (const field of [
    'pagesReviewed',
    'autoFixed',
    'tasksCreated',
    'pagesInvalidated',
  ] as const)
    if (!isFiniteNonNegativeInteger(raw[field]))
      problems.push({ path: field, problem: 'must be a non-negative integer' });
  if (!Array.isArray(raw.findings)) {
    problems.push({ path: 'findings', problem: 'must be an array' });
  } else {
    raw.findings.forEach((finding, index) => {
      if (isRecord(finding)) problems.push(...findingProblems(finding, index));
      else
        problems.push({
          path: `findings[${index}]`,
          problem: 'must be an object',
        });
    });
  }
  if (
    !isString(raw.status) ||
    !RUN_RECORD_STATUSES.includes(raw.status as RunRecordStatus)
  )
    problems.push({
      path: 'status',
      problem: `must be one of ${RUN_RECORD_STATUSES.join(', ')}`,
    });
  if (problems.length > 0) fail(problems);
  return raw as unknown as DocumentationRunRecord;
}

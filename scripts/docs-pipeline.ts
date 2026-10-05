#!/usr/bin/env bun
import type { TextRisk } from './untrusted-text';

export const DOCUMENT_EVENT_VERSION = 'docs-event-v1';

export const DOCUMENT_EVENT_TYPES = [
  'pull_request.merged',
  'release.published',
] as const;
export type DocumentEventType = (typeof DOCUMENT_EVENT_TYPES)[number];

export const DOCUMENT_PIPELINES = [
  'technical-docs',
  'user-docs',
  'blog',
  'accuracy-review',
  'adversarial-review',
  'prose-review',
  'anti-slop-review',
] as const;
export type DocumentPipeline = (typeof DOCUMENT_PIPELINES)[number];

export const CHANGE_KINDS = [
  'feature',
  'contract',
  'breaking',
  'security',
  'configuration',
  'bug-fix',
  'refactor',
  'test-only',
  'documentation-only',
  'unknown',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type DocumentationClassification = {
  readonly changeKind: ChangeKind;
  readonly pipelines: readonly DocumentPipeline[];
  readonly reasons: readonly string[];
};

export type DocumentationEvent = {
  readonly eventVersion: typeof DOCUMENT_EVENT_VERSION;
  readonly eventId: string;
  readonly eventType: DocumentEventType;
  readonly occurredAt: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly commit: string;
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
    readonly url: string;
    readonly author: string | null;
    readonly mergedBy: string | null;
  } | null;
  readonly taskIds: readonly string[];
  readonly changedFiles: readonly string[];
  readonly classification: DocumentationClassification;
  readonly sourceRefs: readonly string[];
  readonly promptVersion?: string;
  readonly textRisk?: TextRisk;
  readonly textRiskReasons?: readonly string[];
  readonly idempotencyKey: string;
};

const featurePattern = /\b(feat|feature|add|introduce|support|implement)\b/i;
const contractPattern =
  /\b(api|protocol|schema|migration|endpoint|command|event|contract)\b/i;
const breakingPattern = /\b(breaking|deprecat|remove|rename)\b/i;
const securityPattern = /\b(auth|security|permission|secret|token|csrf)\b/i;
const configurationPattern =
  /\b(config|configuration|environment|deploy|infra)\b/i;
const bugPattern = /\b(fix|bug|patch)\b/i;
const refactorPattern = /\b(refactor|chore|cleanup)\b/i;

const conventionalPrefixPattern = /^(\w+)(?:\([^)]*\))?:/;
const conventionalBangPattern = /^[a-z]+(?:\([^)]*\))?!:/im;
const CONVENTIONAL_KINDS: Readonly<Record<string, ChangeKind>> = {
  feat: 'feature',
  fix: 'bug-fix',
  refactor: 'refactor',
  chore: 'refactor',
  test: 'test-only',
  docs: 'documentation-only',
  build: 'configuration',
  ci: 'configuration',
  perf: 'refactor',
  style: 'refactor',
};

const isTestFile = (file: string): boolean =>
  /(^|\/)(__tests__|test|tests)(\/|\.)|\.test\.[^.]+$|\.spec\.[^.]+$/i.test(
    file,
  );

const hasAny = (files: readonly string[], pattern: RegExp): boolean =>
  files.some((file) => pattern.test(file));

function determineChangeKind(
  title: string,
  text: string,
  files: readonly string[],
  onlyTests: boolean,
  technicalFiles: boolean,
): ChangeKind {
  if (onlyTests) return 'test-only';
  if (conventionalBangPattern.test(text)) return 'breaking';
  if (breakingPattern.test(text)) return 'breaking';
  if (securityPattern.test(text)) return 'security';
  const prefix = conventionalPrefixPattern.exec(title)?.[1]?.toLowerCase();
  if (prefix && CONVENTIONAL_KINDS[prefix]) return CONVENTIONAL_KINDS[prefix];
  if (contractPattern.test(text) || technicalFiles) return 'contract';
  if (configurationPattern.test(text)) return 'configuration';
  if (bugPattern.test(text)) return 'bug-fix';
  if (refactorPattern.test(text)) return 'refactor';
  if (featurePattern.test(text)) return 'feature';
  return 'unknown';
}

function selectPipelines(input: {
  readonly changeKind: ChangeKind;
  readonly technicalFiles: boolean;
  readonly userFiles: boolean;
  readonly explicitlyBlog: boolean;
}): { pipelines: readonly DocumentPipeline[]; reasons: readonly string[] } {
  const pipelines = new Set<DocumentPipeline>();
  const reasons: string[] = [];
  if (
    input.technicalFiles ||
    ['breaking', 'security', 'contract', 'configuration'].includes(
      input.changeKind,
    )
  ) {
    pipelines.add('technical-docs');
    reasons.push(
      'the change affects technical contracts, architecture, or operations',
    );
  }
  if (
    input.userFiles ||
    ['breaking', 'security', 'feature'].includes(input.changeKind)
  ) {
    pipelines.add('user-docs');
    reasons.push('the change may affect user-visible behavior or workflows');
  }
  if (
    input.explicitlyBlog &&
    ['feature', 'breaking', 'security', 'contract'].includes(input.changeKind)
  ) {
    pipelines.add('blog');
    reasons.push('the change is explicitly marked for blog treatment');
  }
  if (pipelines.size === 0)
    reasons.push('no user-facing or durable contract change was detected');
  return { pipelines: [...pipelines], reasons };
}

export function classifyDocumentationChange(input: {
  readonly title: string;
  readonly body?: string;
  readonly changedFiles: readonly string[];
}): DocumentationClassification {
  const text = `${input.title}\n${input.body ?? ''}`;
  const nonTestFiles = input.changedFiles.filter((file) => !isTestFile(file));
  const onlyTests = input.changedFiles.length > 0 && nonTestFiles.length === 0;
  const technicalFiles =
    hasAny(
      nonTestFiles,
      /^(docs\/|packages\/(protocol|debate-engine|db|auth|config|redis)\/)/,
    ) ||
    hasAny(
      nonTestFiles,
      /(^|\/)(migrations|schema|AGENTS\.md|package\.json)$/,
    ) ||
    hasAny(nonTestFiles, /^\.github\/workflows\//);
  const userFiles =
    hasAny(nonTestFiles, /^(apps\/web\/src\/app|apps\/web\/src\/features)\//) ||
    hasAny(nonTestFiles, /^(README\.md|CONTRIBUTING\.md)$/);
  const explicitlyBlog = /(^|\s)#?blog\b|blog[-_:]/i.test(text);

  const changeKind = determineChangeKind(
    input.title,
    text,
    input.changedFiles,
    onlyTests,
    technicalFiles,
  );
  return {
    changeKind,
    ...selectPipelines({
      changeKind,
      technicalFiles,
      userFiles,
      explicitlyBlog,
    }),
  };
}

export function createDocumentationEvent(input: {
  readonly eventId: string;
  readonly eventType: DocumentationEvent['eventType'];
  readonly occurredAt: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly commit: string;
  readonly pullRequest: NonNullable<DocumentationEvent['pullRequest']> | null;
  readonly taskIds: readonly string[];
  readonly changedFiles: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly promptVersion?: string;
  readonly textRisk?: TextRisk;
  readonly textRiskReasons?: readonly string[];
}): DocumentationEvent {
  const classification = classifyDocumentationChange({
    title: input.pullRequest?.title ?? '',
    body: input.pullRequest?.body ?? undefined,
    changedFiles: input.changedFiles,
  });
  return {
    ...input,
    eventVersion: DOCUMENT_EVENT_VERSION,
    classification,
    sourceRefs: input.sourceRefs ?? input.changedFiles,
    idempotencyKey: `${input.repository}:${input.commit}:${input.eventType}`,
  };
}

export function parseChangedFiles(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n|,/)
        .map((file) => file.trim())
        .filter(Boolean),
    ),
  ].sort();
}

if (import.meta.main) {
  const filesFlag = process.argv.find((arg) => arg.startsWith('--files='));
  const titleFlag = process.argv.find((arg) => arg.startsWith('--title='));
  const files = parseChangedFiles(filesFlag?.slice('--files='.length) ?? '');
  const classification = classifyDocumentationChange({
    title: titleFlag?.slice('--title='.length) ?? '',
    changedFiles: files,
  });
  process.stdout.write(
    `${JSON.stringify({ changedFiles: files, classification }, null, 2)}\n`,
  );
}

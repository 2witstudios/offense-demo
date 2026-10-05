#!/usr/bin/env bun
import {
  createDocumentationEvent,
  DOCUMENT_EVENT_TYPES,
  parseChangedFiles,
  type DocumentEventType,
} from './docs-pipeline';
import { assessEventText } from './untrusted-text';
import { DOCUMENTATION_PROMPT_VERSION } from './docs-prompts';
import { dispatchDocumentationEvent } from './docs-consult';
import { describeOutcomes } from './docs-consult-question';
import { extractTaskIds } from './notify-drive';
import { documentationDrive } from './pagespace-docs';
import {
  driveProvisioned,
  driveSkipNotice,
  loadProjectConfig,
} from './project-config';

if (!driveProvisioned(loadProjectConfig())) {
  console.log(driveSkipNotice('documentation dispatch'));
  process.exit(0);
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const eventType = (): DocumentEventType => {
  const value = process.env.DOC_EVENT_TYPE ?? 'pull_request.merged';
  if (!DOCUMENT_EVENT_TYPES.includes(value as DocumentEventType))
    throw new Error(
      `DOC_EVENT_TYPE must be one of ${DOCUMENT_EVENT_TYPES.join(', ')}`,
    );
  return value as DocumentEventType;
};

const assessed = assessEventText({
  title: required('DOC_TITLE'),
  body: process.env.DOC_BODY ?? null,
  branch: process.env.DOC_BRANCH ?? null,
});

const event = createDocumentationEvent({
  eventId: required('DOC_EVENT_ID'),
  eventType: eventType(),
  occurredAt: required('DOC_OCCURRED_AT'),
  repository: required('DOC_REPOSITORY'),
  baseRef: required('DOC_BASE_REF'),
  commit: required('DOC_COMMIT'),
  pullRequest: {
    number: Number(required('DOC_PR_NUMBER')),
    title: assessed.title,
    body: assessed.body === '' ? null : assessed.body,
    url: required('DOC_PR_URL'),
    author: process.env.DOC_AUTHOR ?? null,
    mergedBy: process.env.DOC_MERGED_BY ?? null,
  },
  taskIds: extractTaskIds(
    [assessed.title, assessed.branch, assessed.body].filter(Boolean).join(' '),
  ),
  changedFiles: parseChangedFiles(required('DOC_CHANGED_FILES')),
  promptVersion: DOCUMENTATION_PROMPT_VERSION,
  textRisk: assessed.textRisk,
  textRiskReasons: assessed.reasons,
});

if (event.classification.pipelines.length === 0) {
  process.stdout.write(
    `Documentation no-op: ${event.classification.reasons.join('; ')}\n`,
  );
} else {
  const outcomes = await dispatchDocumentationEvent(event, {
    drive: documentationDrive(loadProjectConfig()),
  });
  process.stdout.write(
    `Documentation Agent consulted (text risk: ${assessed.textRisk}): ${describeOutcomes(outcomes)}\n`,
  );
}

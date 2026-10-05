#!/usr/bin/env bun
import type { DocumentPipeline } from './docs-pipeline';
import {
  loadProjectConfig,
  requireAgent,
  requireDriveId,
  requirePage,
  type ProjectConfig,
} from './project-config';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where the documentation pipeline lives on the drive, read from
 * `project.config.json` (`pagespace.pages.documentation`, `docsRunsSheet`,
 * `technicalDocs`, `userDocs`, `blog` and `pagespace.agents.documentation`).
 * The drive, root folder and agent accept environment overrides for a
 * staging drive; an unprovisioned id fails with a bootstrap hint.
 */
export type DocumentationDrive = {
  readonly driveId: string;
  readonly rootPageId: string;
  readonly agentPageId: string;
  readonly runsSheetId: string;
  // Merge dispatch only ever routes to these three (selectPipelines in
  // docs-pipeline.ts); the review pipelines audit whatever page they target.
  readonly targetPages: Readonly<Partial<Record<DocumentPipeline, string>>>;
};

export function documentationLocation(
  config: ProjectConfig,
  env: Env = process.env,
): {
  readonly driveId: string;
  readonly rootPageId: string;
  readonly agentPageId: string;
} {
  return {
    driveId: env.PAGESPACE_DOCUMENTATION_DRIVE_ID || requireDriveId(config),
    rootPageId:
      env.PAGESPACE_DOCUMENTATION_ROOT_PAGE_ID ||
      requirePage(config, 'documentation'),
    agentPageId:
      env.PAGESPACE_DOCUMENTATION_AGENT_PAGE_ID ||
      requireAgent(config, 'documentation'),
  };
}

export function documentationDrive(
  config: ProjectConfig,
  env: Env = process.env,
): DocumentationDrive {
  const { technicalDocs, userDocs, blog } = config.pagespace.pages;
  const targets: readonly (readonly [DocumentPipeline, string | null])[] = [
    ['technical-docs', technicalDocs],
    ['user-docs', userDocs],
    ['blog', blog],
  ];
  return {
    ...documentationLocation(config, env),
    runsSheetId: requirePage(config, 'docsRunsSheet'),
    targetPages: Object.fromEntries(
      targets.filter(
        (entry): entry is readonly [DocumentPipeline, string] =>
          entry[1] !== null,
      ),
    ),
  };
}

if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(documentationLocation(loadProjectConfig()), null, 2)}\n`,
  );
}

const DEFAULT_API_URL = 'https://pagespace.ai';

export type PagespaceApiOptions = {
  readonly token?: string;
  readonly apiUrl?: string;
};

// The drive-scoped credential and host every PageSpace call uses. A missing
// token throws rather than skipping the call, and the bearer token only ever
// travels over https.
export function pagespaceApi(options: PagespaceApiOptions = {}): {
  readonly apiUrl: URL;
  readonly headers: Readonly<Record<string, string>>;
} {
  const token = options.token ?? process.env.PAGESPACE_TOKEN ?? '';
  if (!token) throw new Error('Missing PAGESPACE_TOKEN');
  let apiUrl: URL;
  try {
    apiUrl = new URL(
      options.apiUrl ?? process.env.PAGESPACE_API_URL ?? DEFAULT_API_URL,
    );
  } catch {
    throw new Error('PAGESPACE_API_URL is not a valid URL');
  }
  if (apiUrl.protocol !== 'https:')
    throw new Error(
      'PAGESPACE_API_URL must use https to protect the bearer token',
    );
  return {
    apiUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}

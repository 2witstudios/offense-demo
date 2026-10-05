#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocumentationEvent } from './docs-contracts';
import {
  extractCitations,
  provenanceMismatches,
  verifyCitations,
  type Citation,
} from './docs-citations';

const root = resolve(import.meta.dir, '..');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pathExistsAtCommit = (path: string, commit: string): boolean => {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}:${path}`], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

const pathExistsInWorktree = async (path: string): Promise<boolean> => {
  try {
    await stat(join(root, path));
    return true;
  } catch {
    return false;
  }
};

const exists = async (path: string, commit?: string): Promise<boolean> =>
  commit ? pathExistsAtCommit(path, commit) : pathExistsInWorktree(path);

async function main(): Promise<void> {
  const raw = JSON.parse(await new Response(Bun.stdin.stream()).text());
  if (!isRecord(raw))
    throw new Error('verification input must be a JSON object');
  const event = parseDocumentationEvent(raw.event);
  if (
    !isRecord(raw.manifest) &&
    typeof raw.citationsText !== 'string' &&
    !Array.isArray(raw.citations)
  )
    throw new Error(
      'provide a manifest, citationsText, or citations to verify',
    );

  const citations: readonly Citation[] = Array.isArray(raw.citations)
    ? raw.citations
    : typeof raw.citationsText === 'string'
      ? extractCitations(raw.citationsText)
      : [];

  const report = await verifyCitations({
    citations,
    exists,
  });

  const provenance = isRecord(raw.manifest)
    ? provenanceMismatches(event, raw.manifest)
    : [];

  const output = {
    idempotencyKey: event.idempotencyKey,
    verified: report.verified,
    unverified: report.unverified.map(({ citation }) => citation),
    provenanceMismatches: provenance,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.unverified.length > 0 || provenance.length > 0) process.exit(1);
}

if (import.meta.main) {
  await main();
}

import type { DocumentationEvent } from './docs-pipeline';
import { DOCUMENTATION_PROMPT_VERSION } from './docs-prompts';

export type Citation = {
  readonly path: string;
  readonly commit?: string;
};

const CITATION_PATTERN =
  /([\w][\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|sql|toml))(?:@([0-9a-fA-F]{7,40}))?/g;

export function extractCitations(text: string): readonly Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const [, path, commit] of text.matchAll(CITATION_PATTERN)) {
    const key = `${commit ?? ''}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(commit ? { path, commit } : { path });
  }
  return citations;
}

export type CitationReport = {
  readonly verified: readonly Citation[];
  readonly unverified: readonly { readonly citation: Citation }[];
};

export async function verifyCitations(input: {
  readonly citations: readonly Citation[];
  readonly exists: (
    path: string,
    commit?: string,
  ) => boolean | Promise<boolean>;
}): Promise<CitationReport> {
  const verified: Citation[] = [];
  const unverified: { citation: Citation }[] = [];
  for (const citation of input.citations) {
    if (await input.exists(citation.path, citation.commit))
      verified.push(citation);
    else unverified.push({ citation });
  }
  return { verified, unverified };
}

export function provenanceMismatches(
  event: DocumentationEvent,
  manifest: {
    readonly sourceSnapshot?: string;
    readonly promptVersion?: string;
  },
): readonly string[] {
  const mismatches: string[] = [];
  const expectedSnapshot = `${event.repository}@${event.commit}`;
  if (manifest.sourceSnapshot !== expectedSnapshot)
    mismatches.push(`sourceSnapshot must echo ${expectedSnapshot}`);
  if (!manifest.promptVersion)
    mismatches.push('promptVersion must record the prompt version used');
  else if (manifest.promptVersion !== DOCUMENTATION_PROMPT_VERSION)
    mismatches.push(
      `promptVersion must be ${DOCUMENTATION_PROMPT_VERSION}, got ${manifest.promptVersion}`,
    );
  return mismatches;
}

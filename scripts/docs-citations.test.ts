import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import {
  extractCitations,
  provenanceMismatches,
  verifyCitations,
} from './docs-citations';
import { createDocumentationEvent } from './docs-pipeline';
import { DOCUMENTATION_PROMPT_VERSION } from './docs-prompts';

setupRitewayBun();

describe('extractCitations', async () => {
  test('extracts backticked paths with optional commits and dedupes', async () => {
    const actual = extractCitations(
      'The pipeline lives in `scripts/docs-pipeline.ts` and the compose file at ' +
        'infra/compose.yaml@abc1234. See scripts/docs-pipeline.ts again and also ' +
        'docs/architecture/overview.md.',
    );
    assert({
      given: 'prose citing paths, one pinned to a commit',
      should: 'return unique citations with the commit captured',
      actual,
      expected: [
        { path: 'scripts/docs-pipeline.ts', commit: undefined },
        { path: 'infra/compose.yaml', commit: 'abc1234' },
        { path: 'docs/architecture/overview.md', commit: undefined },
      ],
    });
  });

  test('ignores prose without repository paths', async () => {
    const actual = extractCitations(
      'Runs in about 3.5 minutes with bun 1.4.2, no changes required.',
    );
    assert({
      given: 'prose without repository paths',
      should: 'return no citations',
      actual,
      expected: [],
    });
  });
});

describe('verifyCitations', async () => {
  test('splits citations into verified and unverified using the injected checker', async () => {
    const citations = [
      { path: 'scripts/docs-pipeline.ts', commit: undefined },
      { path: 'infra/compose.yaml', commit: 'abc1234' },
      { path: 'docs/does-not-exist.md', commit: undefined },
    ];
    const actual = await verifyCitations({
      citations,
      exists: (path, commit) =>
        commit === undefined && path !== 'docs/does-not-exist.md',
    });
    assert({
      given: 'a mix of resolvable and unresolvable citations',
      should: 'classify each citation',
      actual: {
        verified: actual.verified.length,
        unverified: actual.unverified.map(({ citation }) => citation.path),
      },
      expected: {
        verified: 1,
        unverified: ['infra/compose.yaml', 'docs/does-not-exist.md'],
      },
    });
  });

  test('returns an empty report for an empty citation list', async () => {
    const actual = await verifyCitations({ citations: [], exists: () => true });
    assert({
      given: 'no citations',
      should: 'report nothing verified or unverified',
      actual: {
        verified: actual.verified.length,
        unverified: actual.unverified.length,
      },
      expected: { verified: 0, unverified: 0 },
    });
  });
});

describe('provenanceMismatches', async () => {
  const event = createDocumentationEvent({
    eventId: 'evt-1',
    eventType: 'pull_request.merged',
    occurredAt: '2026-09-20T00:00:00.000Z',
    repository: '2witstudios/offense-demo',
    baseRef: 'main',
    commit: 'abc1234',
    pullRequest: null,
    taskIds: [],
    changedFiles: [],
    promptVersion: DOCUMENTATION_PROMPT_VERSION,
  });

  test('accepts a manifest that echoes the event provenance', async () => {
    const actual = provenanceMismatches(event, {
      sourceSnapshot: '2witstudios/offense-demo@abc1234',
      promptVersion: DOCUMENTATION_PROMPT_VERSION,
    });
    assert({
      given: 'a manifest echoing the repository, commit, and prompt version',
      should: 'report no mismatches',
      actual,
      expected: [],
    });
  });

  test('reports each field that disagrees with the event', async () => {
    const actual = provenanceMismatches(event, {
      sourceSnapshot: '2witstudios/offense-demo@ffff000',
      promptVersion: 'docs-prompt-v0',
    });
    assert({
      given: 'a manifest with a stale snapshot and prompt version',
      should: 'name both mismatches',
      actual:
        actual.length === 2 &&
        actual[0].includes('sourceSnapshot') &&
        actual[1].includes('promptVersion'),
      expected: true,
    });
  });

  test('requires a prompt version on the manifest', async () => {
    const actual = provenanceMismatches(event, {
      sourceSnapshot: '2witstudios/offense-demo@abc1234',
    });
    assert({
      given: 'a manifest without a prompt version',
      should: 'report the missing prompt version',
      actual: actual.some((mismatch) => mismatch.includes('promptVersion')),
      expected: true,
    });
  });
});

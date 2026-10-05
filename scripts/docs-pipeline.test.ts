import { describe, test } from 'riteway/bun';
import { setupRitewayBun, assert } from 'riteway/bun';
import {
  classifyDocumentationChange,
  parseChangedFiles,
} from './docs-pipeline';
import { mergedPullRequestEvent } from './docs-event.test-support';

setupRitewayBun();

describe('classifyDocumentationChange', async () => {
  test('treats a conventional-commit bang as a breaking change', async () => {
    const actual = classifyDocumentationChange({
      title: 'feat(envelopes)!: replace the protocol envelope shape',
      changedFiles: ['packages/protocol/src/events.ts'],
    });
    assert({
      given: 'a conventional commit with a breaking bang',
      should: 'classify as breaking and route technical and user docs',
      actual: {
        changeKind: actual.changeKind,
        pipelines: [...actual.pipelines].sort(),
      },
      expected: {
        changeKind: 'breaking',
        pipelines: ['technical-docs', 'user-docs'],
      },
    });
  });

  test('prefers the conventional type over generic keyword scanning', async () => {
    assert({
      given: 'a docs-prefixed change',
      should: 'classify as documentation-only even though the body says add',
      actual: classifyDocumentationChange({
        title: 'docs: rewrite the lobby guide',
        body: 'adds setup steps',
        changedFiles: ['README.md'],
      }).changeKind,
      expected: 'documentation-only',
    });
    assert({
      given: 'a test-prefixed change touching source files',
      should: 'classify as test-only rather than feature',
      actual: classifyDocumentationChange({
        title: 'test: cover tournament rejection paths',
        changedFiles: ['apps/web/src/features/tournaments/operations.ts'],
      }).changeKind,
      expected: 'test-only',
    });
  });

  test('still lets breaking and security keywords outrank the prefix', async () => {
    assert({
      given: 'a security keyword in a fix-prefixed title',
      should: 'classify as security',
      actual: classifyDocumentationChange({
        title: 'fix: auth token rotation drops active sessions',
        changedFiles: ['packages/db/src/index.ts'],
      }).changeKind,
      expected: 'security',
    });
    assert({
      given: 'a deprecation keyword without a prefix',
      should: 'classify as breaking',
      actual: classifyDocumentationChange({
        title: 'remove the deprecated passkey endpoint',
        changedFiles: ['apps/web/src/features/auth/operations.ts'],
      }).changeKind,
      expected: 'breaking',
    });
  });

  test('reports unknown for an empty change instead of pretending', async () => {
    const actual = classifyDocumentationChange({
      title: '',
      changedFiles: [],
    });
    assert({
      given: 'an empty title and no changed files',
      should: 'classify as unknown with a no-op reason',
      actual: { changeKind: actual.changeKind, pipelines: actual.pipelines },
      expected: { changeKind: 'unknown', pipelines: [] },
    });
  });

  test('routes a public feature to technical and user documentation', async () => {
    const actual = classifyDocumentationChange({
      title: 'feat: add tournament registration',
      changedFiles: ['apps/web/src/app/tournaments/register/page.tsx'],
    });
    assert({
      given: 'a merged user-visible feature',
      should: 'route it to the technical and user documentation pipelines',
      actual: actual.pipelines,
      expected: ['user-docs'],
    });
  });

  test('does not create documentation work for a test-only change', async () => {
    const actual = classifyDocumentationChange({
      title: 'test: cover registration rejection',
      changedFiles: ['apps/web/src/features/tournaments/operations.test.ts'],
    });
    assert({
      given: 'a test-only merge',
      should: 'produce a no-op pipeline set',
      actual: actual.pipelines,
      expected: [],
    });
  });

  test('routes redis adapter behavior changes to technical documentation', async () => {
    const actual = classifyDocumentationChange({
      title: 'fix: correct presence key lifetime',
      changedFiles: ['packages/redis/src/index.ts'],
    });
    assert({
      given: 'a redis adapter behavior fix',
      should: 'include the technical documentation pipeline',
      actual: actual.pipelines,
      expected: ['technical-docs'],
    });
  });

  test('requires an explicit blog marker', async () => {
    const actual = classifyDocumentationChange({
      title: 'feat: add tournament registration',
      body: 'blog: announce this feature',
      changedFiles: ['apps/web/src/app/tournaments/register/page.tsx'],
    });
    assert({
      given: 'a feature explicitly marked for a blog post',
      should: 'include the blog pipeline',
      actual: actual.pipelines,
      expected: ['user-docs', 'blog'],
    });
  });
});

describe('createDocumentationEvent', async () => {
  test('includes stable provenance and idempotency metadata', async () => {
    const actual = mergedPullRequestEvent({
      promptVersion: 'docs-prompt-v1',
    });
    assert({
      given: 'a merge event',
      should: 'retain its source and stable replay key',
      actual: {
        version: actual.eventVersion,
        sourceRefs: actual.sourceRefs,
        idempotencyKey: actual.idempotencyKey,
        promptVersion: actual.promptVersion,
      },
      expected: {
        version: 'docs-event-v1',
        sourceRefs: ['packages/protocol/src/events.ts'],
        idempotencyKey: 'offense-demo:abc123:pull_request.merged',
        promptVersion: 'docs-prompt-v1',
      },
    });
  });
});

describe('parseChangedFiles', async () => {
  test('normalizes comma and newline separated files', async () => {
    assert({
      given: 'a CI file list',
      should: 'return unique sorted paths',
      actual: parseChangedFiles('b.ts\na.ts,b.ts'),
      expected: ['a.ts', 'b.ts'],
    });
  });
});

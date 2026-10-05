import { readFileSync } from 'node:fs';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  findProbeImportProblems,
  findProbeWorkflowProblem,
} from './verify-deploy-config';

setupRitewayBun();

const readRepoFile = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const realProbeWorkflow = readFileSync(
  '.github/workflows/auth-alerts.yml',
  'utf8',
);

/** An in-memory repository for the import graph. */
const repo =
  (files: Readonly<Record<string, string>>) =>
  (path: string): string | undefined =>
    files[path];

describe('findProbeImportProblems (ISSUE-225)', () => {
  test('the committed probe and notify-drive import no package, transitively', () => {
    assert({
      given:
        'scripts/auth-alert-probe.ts, scripts/notify-drive.ts and every module they import',
      should: 'report no problem',
      actual: findProbeImportProblems(readRepoFile),
      expected: [],
    });
  });

  test('a bare specifier anywhere in the runtime import graph', () => {
    const files = {
      'scripts/auth-alert-probe.ts': [
        "import { createHmac } from 'node:crypto';",
        "import { serve } from 'bun';",
        "import { expect } from 'bun:test';",
        "import type { Schema } from 'type-only-package';",
        "import { helper } from './helper';",
      ].join('\n'),
      'scripts/notify-drive.ts': [
        "export * from './re-exported';",
        "const late = await import('left-pad');",
        "import { gone } from './missing';",
      ].join('\n'),
      'scripts/helper.ts': "import { z } from 'zod';\nexport const helper = z;",
      'scripts/re-exported.ts': "export { thing } from '@scope/pkg/sub';",
    };
    assert({
      given:
        'builtins and a type-only import in the probe, a helper importing zod, a re-export of a scoped package, a dynamic import and an unresolvable relative import',
      should:
        'report every package import and the unresolvable module, and nothing for builtins or type-only imports',
      actual: findProbeImportProblems(repo(files)),
      expected: [
        "scripts/helper.ts imports package 'zod'",
        "scripts/notify-drive.ts imports './missing', which does not resolve to a file",
        "scripts/notify-drive.ts imports package 'left-pad'",
        "scripts/re-exported.ts imports package '@scope/pkg/sub'",
      ],
    });
  });
});

const SETUP = `      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: .bun-version
`;
const PROBE = `      - name: Probe
        run: >-
          bun --no-install scripts/auth-alert-probe.ts
          --origin https://example.test
`;
const job = (...steps: string[]) =>
  `jobs:\n  probe:\n    steps:\n${steps.join('')}`;

describe('findProbeWorkflowProblem (ISSUE-225)', () => {
  test('the committed auth-alerts workflow installs nothing and forbids auto-install', () => {
    assert({
      given: 'the real .github/workflows/auth-alerts.yml',
      should: 'report no problem',
      actual: findProbeWorkflowProblem(realProbeWorkflow),
      expected: null,
    });
  });

  test('a job that could fetch packages', () => {
    assert({
      given:
        'the two steps; then an install step, a probe without --no-install, a Bun set up without .bun-version, and no probe at all',
      should: 'accept only the first and report each other one',
      actual: [
        job(SETUP, PROBE),
        job(SETUP, '      - run: bun install --frozen-lockfile\n', PROBE),
        job(SETUP, PROBE.replace('bun --no-install ', 'bun ')),
        job(
          SETUP.replace(
            'bun-version-file: .bun-version',
            "bun-version: '1.4.2'",
          ),
          PROBE,
        ),
        job(SETUP),
      ].map((workflow) => findProbeWorkflowProblem(workflow) === null),
      expected: [true, false, false, false, false],
    });
  });
});

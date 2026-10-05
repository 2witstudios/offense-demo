import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ISSUE-1 (ADR 0040): every action a workflow runs is pinned to a full commit
 * SHA with its version as a trailing comment, which Dependabot reads to keep
 * proposing bumps; a tag is a mutable pointer whoever controls it can
 * retarget. Local (`./`) and `docker://` references are not tags.
 */
const PINNED_ACTION =
  /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}\s+#\s*v?\d[\w.-]*$/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/;

function unpinnedActionProblems(path: string, text: string): string[] {
  return text.split('\n').flatMap((line, index) => {
    const match = line.match(USES_LINE);
    if (!match) return [];
    const reference = match[1].replace(/^['"]|['"]$/g, '');
    if (reference.startsWith('./') || reference.startsWith('docker://'))
      return [];
    return PINNED_ACTION.test(reference)
      ? []
      : [
          `${path}:${index + 1}: action is not pinned to a full commit SHA with a version comment: ${reference}`,
        ];
  });
}

/** A credential expression: a repository secret or the job's GitHub token. */
const CREDENTIAL = /\$\{\{[^}]*\b(?:secrets\.|github\.token\b)/;

type Workflow = {
  readonly env?: Record<string, unknown>;
  readonly jobs?: Record<
    string,
    { readonly env?: Record<string, unknown>; readonly secrets?: unknown }
  >;
};

const credentialKeys = (env: Record<string, unknown> | undefined) =>
  Object.entries(env ?? {})
    .filter(([, value]) => CREDENTIAL.test(String(value)))
    .map(([key]) => key);

/**
 * Secrets are exposed only on the step that uses them (ISSUE-1): a workflow
 * or job `env` credential reaches every step, third-party actions included,
 * and `secrets: inherit` hands a called workflow all of them.
 */
function broadSecretProblems(path: string, workflow: Workflow): string[] {
  const workflowLevel = credentialKeys(workflow.env).map(
    (key) =>
      `${path}: workflow env ${key} holds a credential; scope it to the step that uses it`,
  );
  const jobLevel = Object.entries(workflow.jobs ?? {}).flatMap(([id, job]) => [
    ...credentialKeys(job.env).map(
      (key) =>
        `${path}: job ${id} env ${key} holds a credential; scope it to the step that uses it`,
    ),
    ...(job.secrets === 'inherit'
      ? [`${path}: job ${id} passes secrets: inherit`]
      : []),
  ]);
  return [...workflowLevel, ...jobLevel];
}

export function workflowHardeningProblems(
  path: string,
  text: string,
): readonly string[] {
  return [
    ...unpinnedActionProblems(path, text),
    ...broadSecretProblems(path, Bun.YAML.parse(text) as Workflow),
  ];
}

export function collectWorkflowHardeningProblems(
  root: string,
): readonly string[] {
  const directory = join(root, '.github/workflows');
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) =>
      workflowHardeningProblems(
        `.github/workflows/${name}`,
        readFileSync(join(directory, name), 'utf8'),
      ),
    );
}

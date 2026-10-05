/**
 * The policy exception and migration-baseline registries' validation, split
 * from policy.ts (which scans the tree and reports): every registry entry is
 * complete, points at real paths and ADRs, names a known rule and category,
 * and has not outlived its review date.
 */
import { stylingRules, type StylingRule } from './policy-styling';
import { registryEntries } from './registry-entries';
import { reviewDateStatus, utcToday } from './review-date';

export type PolicyRule =
  'direct-random-uuid' | 'repository-owned-uuid' | StylingRule;
type PolicyCategory =
  'framework' | 'integration-isolation' | 'migration' | 'tooling';
export type PolicyException = {
  readonly path: string;
  readonly rule: PolicyRule;
  readonly category: PolicyCategory;
  readonly owner: string;
  readonly reason: string;
  readonly adr: string;
  readonly reviewBy: string;
};

// policy.ts's rule table is a Record<PolicyRule, RegExp>, so these names and
// its keys cannot drift apart without a type error there.
const ruleNames: ReadonlySet<string> = new Set<PolicyRule>([
  'direct-random-uuid',
  'repository-owned-uuid',
  ...(Object.keys(stylingRules) as StylingRule[]),
]);
const categories = new Set<PolicyCategory>([
  'framework',
  'integration-isolation',
  'migration',
  'tooling',
]);

export type PolicyRegistryValidationOptions = {
  readonly knownPaths?: ReadonlySet<string>;
  readonly today?: string;
};

type RegistryEntry = Partial<PolicyException>;

function requiredFieldProblems(
  entry: RegistryEntry,
  prefix: string,
): readonly string[] {
  return (
    ['path', 'rule', 'category', 'owner', 'reason', 'adr', 'reviewBy'] as const
  )
    .filter(
      (field) => typeof entry[field] !== 'string' || entry[field].trim() === '',
    )
    .map((field) => `${prefix}: ${field} is required`);
}

function referenceProblems(
  entry: RegistryEntry,
  prefix: string,
  knownPaths: ReadonlySet<string> | undefined,
): readonly string[] {
  const problems: string[] = [];
  if (typeof entry.path === 'string' && entry.path.includes('*'))
    problems.push(`${prefix}: wildcard paths are not allowed`);
  if (
    typeof entry.path === 'string' &&
    knownPaths &&
    !knownPaths.has(entry.path)
  )
    problems.push(`${prefix}: path does not exist: ${entry.path}`);
  if (typeof entry.rule === 'string' && !ruleNames.has(entry.rule))
    problems.push(`${prefix}: unknown rule ${entry.rule}`);
  if (
    typeof entry.category === 'string' &&
    !categories.has(entry.category as PolicyCategory)
  )
    problems.push(`${prefix}: unknown category ${entry.category}`);
  if (
    typeof entry.adr === 'string' &&
    !/^docs\/decisions\/\d{4}-[a-z0-9-]+\.md$/.test(entry.adr)
  )
    problems.push(`${prefix}: invalid ADR reference ${entry.adr}`);
  if (typeof entry.adr === 'string' && knownPaths && !knownPaths.has(entry.adr))
    problems.push(`${prefix}: ADR does not exist: ${entry.adr}`);
  return problems;
}

function reviewDateProblems(
  reviewBy: string | undefined,
  prefix: string,
  today: string,
): readonly string[] {
  if (typeof reviewBy !== 'string') return [];
  const status = reviewDateStatus(reviewBy, today);
  if (status === 'invalid') return [`${prefix}: reviewBy must be an ISO date`];
  return status === 'expired'
    ? [`${prefix}: reviewBy has expired: ${reviewBy}`]
    : [];
}

function exceptionProblems(
  entry: RegistryEntry,
  prefix: string,
  options: PolicyRegistryValidationOptions,
  today: string,
): readonly string[] {
  return [
    ...requiredFieldProblems(entry, prefix),
    ...referenceProblems(entry, prefix, options.knownPaths),
    ...reviewDateProblems(entry.reviewBy, prefix, today),
  ];
}

export function validatePolicyRegistry(
  registry: { version?: unknown; exceptions?: unknown },
  options: PolicyRegistryValidationOptions = {},
): readonly string[] {
  const today = options.today ?? utcToday();
  const { problems, entries } = registryEntries(registry, 'exceptions');
  if (entries === undefined) return problems;
  const seen = new Set<string>();
  for (const [index, value] of entries.entries()) {
    const entry = value as RegistryEntry;
    const prefix = `registry[${index}]`;
    problems.push(...exceptionProblems(entry, prefix, options, today));
    const key = `${entry.path}|${entry.rule}`;
    if (seen.has(key)) problems.push(`${prefix}: duplicate ${key}`);
    seen.add(key);
  }
  return problems;
}

export type MigrationBaseline = {
  readonly baseMigrationsHash: string;
  readonly adr: string;
  readonly owner: string;
  readonly reason: string;
  readonly reviewBy: string;
};

export function validateMigrationBaselines(
  registry: { version?: unknown; baselines?: unknown },
  options: PolicyRegistryValidationOptions = {},
): readonly string[] {
  const today = options.today ?? utcToday();
  const { problems, entries } = registryEntries(registry, 'baselines');
  if (entries === undefined) return problems;
  for (const [index, value] of entries.entries()) {
    const entry = value as Partial<MigrationBaseline>;
    const prefix = `baselines[${index}]`;
    for (const field of [
      'baseMigrationsHash',
      'adr',
      'owner',
      'reason',
      'reviewBy',
    ] as const)
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        problems.push(`${prefix}: ${field} is required`);
    if (
      typeof entry.baseMigrationsHash === 'string' &&
      !/^sha256:[0-9a-f]{64}$/.test(entry.baseMigrationsHash)
    )
      problems.push(
        `${prefix}: baseMigrationsHash must be sha256:<64 lowercase hex>`,
      );
    problems.push(
      ...referenceProblems(
        { adr: entry.adr } as RegistryEntry,
        prefix,
        options.knownPaths,
      ),
    );
    if (typeof entry.reviewBy === 'string')
      problems.push(...reviewDateProblems(entry.reviewBy, prefix, today));
  }
  return problems;
}

// Citations read "ADR 0017", so two records sharing a number make every such
// citation ambiguous. Nested directories and unnumbered files are ignored.
export function duplicateAdrNumberProblems(
  paths: Iterable<string>,
): readonly string[] {
  const byNumber = new Map<string, string[]>();
  for (const path of paths) {
    const number = /^docs\/decisions\/(\d{4})-[^/]+\.md$/.exec(path)?.[1];
    if (number !== undefined)
      byNumber.set(number, [...(byNumber.get(number) ?? []), path]);
  }
  return [...byNumber]
    .filter(([, files]) => files.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([number, files]) =>
        `decisions: ADR number ${number} is shared by ${[...files].sort().join(', ')}`,
    );
}

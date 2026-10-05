/** A versioned registry's entry list, or the problems that prevent reading it. */
export function registryEntries(
  registry: Readonly<Record<string, unknown>>,
  key: string,
): { problems: string[]; entries: readonly unknown[] | undefined } {
  const problems: string[] = [];
  if (registry.version !== 1) problems.push('registry: version must be 1');
  const entries = registry[key];
  if (!Array.isArray(entries))
    return {
      problems: [...problems, `registry: ${key} must be an array`],
      entries: undefined,
    };
  return { problems, entries };
}

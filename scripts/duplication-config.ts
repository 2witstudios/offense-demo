// Guards `.jscpd.json` against silent shrinkage: jscpd's `failOnEmpty` only
// fires when the whole scan matches nothing, so a renamed directory would
// otherwise drop one scan root and keep passing (ADR 0026).

type DuplicationConfig = {
  readonly pattern: string;
  readonly ignore: readonly string[];
};

const scannable = /\.(ts|tsx|js|jsx|css)$/;

/** `{a,b}/**` → `['a/**', 'b/**']`; one (unnested) brace group is supported. */
export const scanRootPatterns = (pattern: string): readonly string[] => {
  const group = /^(.*?)\{([^{}]*)\}(.*)$/.exec(pattern);
  if (!group) return [pattern];
  const [, prefix = '', alternatives = '', suffix = ''] = group;
  return alternatives.split(',').map((root) => `${prefix}${root}${suffix}`);
};

/** Scan roots that match no tracked, scannable, non-ignored file. */
export const deadScanRoots = (
  { pattern, ignore }: DuplicationConfig,
  trackedFiles: readonly string[],
): readonly string[] => {
  const ignored = ignore.map((glob) => new Bun.Glob(glob));
  const candidates = trackedFiles.filter(
    (file) => scannable.test(file) && !ignored.some((glob) => glob.match(file)),
  );
  return scanRootPatterns(pattern).filter((root) => {
    const glob = new Bun.Glob(root);
    return !candidates.some((file) => glob.match(file));
  });
};

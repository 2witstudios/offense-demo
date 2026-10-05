import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { repositoryEslint } from '../eslint.config.test-support';

setupRitewayBun();

// Token-locked Tailwind (ADR 0028), split from eslint.config.test.ts. Each
// test allows minutes, not Bun's fixed 5 s: building the lint program is
// slow under load (as in eslint-purity.test.ts).
const LINT_TIMEOUT_MS = 180_000;

describe('token-locked Tailwind lint rules (ADR 0028)', () => {
  const lintMarkup = async (classes: string) => {
    const eslint = repositoryEslint();
    const [result] = await eslint.lintText(
      `export const Probe = () => <div className="${classes}" />;`,
      { filePath: 'apps/web/src/ui/probe.tsx' },
    );
    return result.messages.map(({ ruleId }) => ruleId);
  };

  test(
    'accepts registered token classes',
    async () => {
      assert({
        given: 'classes that all come from the Offense Demo theme',
        should: 'report nothing',
        actual: await lintMarkup('bg-surface p-4 text-ink-muted max-rail:p-2'),
        expected: [],
      });
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'rejects arbitrary values and properties',
    async () => {
      assert({
        given: 'an arbitrary value and an arbitrary property',
        should: 'report the restricted-class rule for both',
        actual: await lintMarkup('w-[10px] [mask-type:luminance]'),
        expected: [
          'better-tailwindcss/no-restricted-classes',
          'better-tailwindcss/no-restricted-classes',
        ],
      });
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'rejects default-theme classes the reset removed',
    async () => {
      assert({
        given:
          'bg-red-500 and p-7, which Tailwind ships but Offense Demo does not',
        should: 'report both as unknown',
        actual: await lintMarkup('bg-red-500 p-7'),
        expected: [
          'better-tailwindcss/no-unknown-classes',
          'better-tailwindcss/no-unknown-classes',
        ],
      });
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'rejects conflicting classes',
    async () => {
      assert({
        given: 'two padding utilities on one element',
        should: 'report the conflict on each',
        actual: await lintMarkup('p-2 p-4'),
        expected: [
          'better-tailwindcss/no-conflicting-classes',
          'better-tailwindcss/no-conflicting-classes',
        ],
      });
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'rejects duplicate classes',
    async () => {
      assert({
        given: 'the same class twice',
        should: 'report a duplicate',
        actual: await lintMarkup('p-4 flex p-4'),
        expected: ['better-tailwindcss/no-duplicate-classes'],
      });
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'rejects per-element dark variants',
    async () => {
      assert({
        given: 'a dark: variant and a color-scheme utility',
        should: 'report the restricted-class rule for each',
        actual: await lintMarkup('dark:bg-surface scheme-dark'),
        expected: [
          'better-tailwindcss/no-restricted-classes',
          'better-tailwindcss/no-restricted-classes',
        ],
      });
    },
    LINT_TIMEOUT_MS,
  );

  test(
    'checks the class strings in variant class modules',
    async () => {
      const eslint = repositoryEslint();
      const [result] = await eslint.lintText(
        [
          "const base = 'w-[10px] flex';",
          "const tones = { quiet: 'bg-surfce', loud: 'dark:bg-surface' } as const;",
          'export const probeClass = (tone: keyof typeof tones): string =>',
          '  `${base} ${tones[tone]}`;',
        ].join('\n'),
        { filePath: 'apps/web/src/ui/components/probe/probe-class.ts' },
      );
      assert({
        given:
          'an arbitrary value, a misspelled token and a dark: variant held in a class module',
        should: 'report each one, whatever the variable is named',
        actual: result.messages.map(({ ruleId }) => ruleId),
        expected: [
          'better-tailwindcss/no-restricted-classes',
          'better-tailwindcss/no-unknown-classes',
          'better-tailwindcss/no-restricted-classes',
        ],
      });
    },
    LINT_TIMEOUT_MS,
  );
});

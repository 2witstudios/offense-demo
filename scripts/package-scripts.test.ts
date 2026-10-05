import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { partitionAffected, planGates } from './check-affected';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname;
const { scripts } = (await Bun.file(`${root}package.json`).json()) as {
  scripts: Record<string, string>;
};

const lintTimeout = (script: string | undefined): number =>
  Number(
    /bun test --timeout (\d+) eslint\.config\.test\.ts/.exec(
      script ?? '',
    )?.[1] ?? 0,
  );

describe('package scripts', () => {
  test('runs the ESLint configuration test with a load-tolerant timeout', () => {
    assert({
      given:
        'the lint and test:lint scripts, and the check:affected gate the pre-push hook runs',
      should:
        'give eslint.config.test.ts at least two minutes, not the fixed 5 s default',
      actual: [
        lintTimeout(scripts.lint),
        lintTimeout(scripts['test:lint']),
        lintTimeout(
          planGates(partitionAffected(['eslint.config.mjs']), 'base')
            .find(({ name }) => name === 'eslint config tests')
            ?.args.join(' '),
        ),
      ].map((ms) => ms >= 120_000),
      expected: [true, true, true],
    });
  });
});

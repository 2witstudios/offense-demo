import { ESLint } from 'eslint';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

// The repository config, linted from the repository root. Each test allows
// minutes, not Bun's fixed 5 s: building the lint program is slow under load.
const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: './eslint.config.mjs',
});

describe('domain and contract purity (ISSUE-9)', () => {
  const ambientReads = [
    'performance.now();',
    'crypto.getRandomValues(new Uint8Array(1));',
    'process.env.DATABASE_URL;',
    'setTimeout(() => {}, 1);',
    'setInterval(() => {}, 1);',
    'queueMicrotask(() => {});',
    'Bun.env;',
    'globalThis.performance.now();',
  ];
  // Only the purity rule counts: `process.env;` alone also trips
  // no-unused-expressions, which would pass this test without the ban.
  const purityErrors = async (code: string, filePath: string) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.filter(
      ({ ruleId, severity }) =>
        ruleId === 'no-restricted-globals' && severity === 2,
    ).length;
  };

  test('rejects ambient clocks, randomness, environment, timers and Bun in domain and contract packages', async () => {
    const paths = [
      'packages/domain/src/ambient.ts',
      'packages/protocol/src/ambient.ts',
      'packages/errors/src/ambient.ts',
      'packages/auth/src/ambient.ts',
    ];
    const reported = await Promise.all(
      paths.flatMap((filePath) =>
        ambientReads.map(
          async (code) => (await purityErrors(code, filePath)) > 0,
        ),
      ),
    );
    assert({
      given: 'each ambient read in each pure package',
      should: 'report a no-restricted-globals error for every one',
      actual: reported,
      expected: reported.map(() => true),
    });
  }, 180_000);

  test('leaves the app edges free to read the host clock', async () => {
    assert({
      given: 'performance.now() in an app request edge',
      should: 'not be reported by the purity rule',
      actual: await purityErrors(
        'export const start = () => performance.now();',
        'apps/web/src/server/timing.ts',
      ),
      expected: 0,
    });
  }, 180_000);
});

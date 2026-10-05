import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Glob } from 'bun';

setupRitewayBun();

const packageRoot = new URL('../', import.meta.url).pathname;

/**
 * PROJ-1.1: `packages/db` takes and returns plain records, never domain
 * entities, so it never depends on `@offense-demo/domain` — not in its
 * manifest and not in any source file it ships or tests with.
 */
describe('the db/domain boundary (PROJ-1.1)', () => {
  test('packages/db declares and imports nothing from @offense-demo/domain', async () => {
    const manifest = (await Bun.file(`${packageRoot}package.json`).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
    ].flatMap((deps) => Object.keys(deps ?? {}));
    const importers: string[] = [];
    for await (const path of new Glob('{src,integration,scripts}/**/*.ts').scan(
      packageRoot,
    )) {
      const source = await Bun.file(`${packageRoot}${path}`).text();
      if (
        /from\s+['"]@offense-demo\/domain|import\(\s*['"]@offense-demo\/domain/.test(
          source,
        )
      )
        importers.push(path);
    }
    assert({
      given: "packages/db's manifest and every TypeScript file in it",
      should: 'neither declare nor import @offense-demo/domain',
      actual: {
        declared: declared.filter((name) => name === '@offense-demo/domain'),
        importers,
      },
      expected: { declared: [], importers: [] },
    });
  });
});

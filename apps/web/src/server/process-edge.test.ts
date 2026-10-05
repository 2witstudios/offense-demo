import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createProcessEdge, type ProcessHolder } from './process-edge';

setupRitewayBun();

type Value = { readonly name: string };

/** A plain holder standing in for `globalThis`, and a build that counts. */
const setup = () => {
  const holder: ProcessHolder<Value> = {};
  let builds = 0;
  const edge = createProcessEdge(holder, () => {
    builds += 1;
    return { name: `built-${builds}` };
  });
  return { holder, edge, builds: () => builds };
};

const errorOf = (run: () => unknown) => {
  try {
    run();
    return '';
  } catch (error) {
    return String(error);
  }
};

describe('createProcessEdge', () => {
  test('builds on first use and serves that one value ever after', () => {
    const { holder, edge, builds } = setup();
    const before = { held: edge.held(), builds: builds() };
    const first = edge.get();
    const second = edge.get();
    assert({
      given: 'an empty holder read twice',
      should: 'build nothing until the first read, then build exactly once',
      actual: {
        before,
        same: first === second,
        builds: builds(),
        inHolder: holder.offenseDemoWebApp === first,
      },
      expected: {
        before: { held: undefined, builds: 0 },
        same: true,
        builds: 1,
        inHolder: true,
      },
    });
  });

  test('serves an adopted value without building one', () => {
    const { edge, builds } = setup();
    const adopted = { name: 'adopted' };
    edge.adopt(adopted);
    assert({
      given: 'a value adopted before the first read',
      should: 'serve it and never call build',
      actual: { served: edge.get() === adopted, builds: builds() },
      expected: { served: true, builds: 0 },
    });
  });

  test('refuses to adopt once a value is held', () => {
    const afterBuild = setup();
    const built = afterBuild.edge.get();
    const refusedAfterBuild = errorOf(() =>
      afterBuild.edge.adopt({ name: 'late' }),
    );
    const afterAdopt = setup();
    const first = { name: 'first' };
    afterAdopt.edge.adopt(first);
    const refusedAfterAdopt = errorOf(() =>
      afterAdopt.edge.adopt({ name: 'second' }),
    );
    assert({
      given: 'an adopt after a build, and a second adopt',
      should: 'refuse both and keep serving the value already held',
      actual: {
        refusedAfterBuild: refusedAfterBuild.includes('already'),
        keptBuilt: afterBuild.edge.get() === built,
        refusedAfterAdopt: refusedAfterAdopt.includes('already'),
        keptFirst: afterAdopt.edge.get() === first,
      },
      expected: {
        refusedAfterBuild: true,
        keptBuilt: true,
        refusedAfterAdopt: true,
        keptFirst: true,
      },
    });
  });

  test('does not hold a value whose build failed', () => {
    const holder: ProcessHolder<Value> = {};
    let attempts = 0;
    const edge = createProcessEdge(holder, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Invalid server configuration');
      return { name: 'recovered' };
    });
    const failed = errorOf(() => edge.get());
    assert({
      given: 'a first build that throws',
      should: 'hold nothing, so the next read builds again',
      actual: {
        failed: failed.includes('Invalid server configuration'),
        held: edge.held(),
        next: edge.get().name,
      },
      expected: { failed: true, held: undefined, next: 'recovered' },
    });
  });
});

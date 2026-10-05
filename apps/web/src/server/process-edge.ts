/** Where a process edge keeps its one value: `globalThis` in production. */
export type ProcessHolder<Value> = { offenseDemoWebApp?: Value };

/**
 * The process edge's caching, free of any global: `get` builds the held
 * value on first use and serves it ever after (a build that throws holds
 * nothing, so the next read tries again); `adopt` lets a process entry hand
 * in the value to serve, and refuses once one is held so a value is never
 * swapped out from under requests.
 */
export function createProcessEdge<Value>(
  holder: ProcessHolder<Value>,
  build: () => Value,
) {
  return {
    get: (): Value => (holder.offenseDemoWebApp ??= build()),
    adopt: (value: Value) => {
      if (holder.offenseDemoWebApp !== undefined)
        throw new Error('This process already runs an app');
      holder.offenseDemoWebApp = value;
    },
    /** The held value, if any, without building one. */
    held: (): Value | undefined => holder.offenseDemoWebApp,
  };
}

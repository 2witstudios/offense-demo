import { systemClock, systemId } from '@offense-demo/clock';
import { createApp, type App } from './app';
import { createProcessEdge, type ProcessHolder } from './process-edge';
import { createRouteBinder } from './route-binding';
import { createRoutes, type Routes } from './routes';
import { readStartOptions } from './start-options';

/**
 * The web process edge, and the only module that reads `process.env` or
 * `globalThis` (eslint.config.mjs, ISSUE-7 block: no-restricted-properties
 * and no-restricted-globals). Next loads route modules, the proxy and
 * instrumentation as separate bundles that share only `globalThis`, so the
 * one app this server process runs is kept there, built on first use from
 * the real environment, fetch, clock and ids. Only route bindings and the
 * process entries import this module (no-restricted-imports); everything
 * else receives the app, or a part of it, as an argument, and tests build
 * their own with `createApp`.
 */
type ProcessState = { readonly app: App; readonly routes: Routes };

const stateFor = (app: App): ProcessState => ({
  app,
  routes: createRoutes(app),
});

const edge = createProcessEdge(
  globalThis as typeof globalThis & ProcessHolder<ProcessState>,
  () =>
    stateFor(
      createApp({
        env: process.env,
        fetch: globalThis.fetch,
        clock: systemClock,
        ids: systemId,
      }),
    ),
);

/** This process's app, built on first use. */
export const processApp = (): App => edge.get().app;

/** Binds a Next route export to this process's route table. */
export const processRoute = createRouteBinder(() => edge.get().routes);

/**
 * For a process entry that composes its own app before the server starts
 * (the browser suite's server, which captures outbound mail): makes it this
 * process's app. Refuses once one exists.
 */
export const adoptProcessApp = (app: App) => edge.adopt(stateFor(app));

/** Closes this process's app if one was built. */
export async function closeProcessApp() {
  await edge.held()?.app.close();
}

/** The production server's validated launch settings. */
export const processStartOptions = () => readStartOptions(process.env);

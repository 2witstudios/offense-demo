/**
 * The one piece of playwright-core the stall evidence uses (ISSUE-279): the
 * `debug` instance behind its DEBUG=pw:* logging, exported by the package
 * as `playwright-core/lib/utilsBundle` and shipped without types. Enabling
 * `pw:protocol` on it is how Playwright's own protocol log is switched on.
 */
declare module 'playwright-core/lib/utilsBundle' {
  type Debug = {
    enable(namespaces: string): void;
    disable(): string;
    enabled(namespace: string): boolean;
    log: (...args: unknown[]) => void;
  };
  const utilsBundle: { readonly debug: Debug };
  export default utilsBundle;
}

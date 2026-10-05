/**
 * The Lua scripts the adapter runs (ISSUE-274). Test clients let code under
 * test run exactly these and no other script, so a test cannot smuggle a
 * `redis.call('FLUSHDB')` through EVAL: every script is defined once, here or
 * beside its caller, through `defineScript`.
 */
const registered = new Set<string>();

/** Registers a script the adapter runs and returns its text. */
export const defineScript = (text: string): string => {
  registered.add(text);
  return text;
};

/** Whether `text` is a script the adapter registered. */
export const isRegisteredScript = (text: string): boolean =>
  registered.has(text);

/** Every registered script (for tests). */
export const registeredScripts = (): ReadonlySet<string> => registered;

import {
  AGENT_KEYS,
  CHANNEL_KEYS,
  PAGE_KEYS,
  parseProjectConfig,
  type ProjectConfig,
} from './project-config';

/**
 * A deterministic fake id shaped like a PageSpace cuid2 (24 lowercase
 * alphanumerics), derived from its kind and key so every id is distinct and
 * readable in a failing assertion. Never a real drive id.
 */
export const fakeId = (kind: 'drive' | 'p' | 'c' | 'a', key = ''): string =>
  `${kind}${key.toLowerCase()}${'x'.repeat(24)}`.slice(0, 24);

const ids = <K extends string>(kind: 'p' | 'c' | 'a', keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, fakeId(kind, key)])) as Record<
    K,
    string
  >;

/** The raw JSON of a fully provisioned config, before validation. */
export const provisionedConfigJson = () => ({
  version: 1,
  name: 'offense-demo',
  displayName: 'Offense Demo',
  repo: '2witstudios/offense-demo',
  owner: '2witstudios',
  autonomyEnv: 'AGENT_AUTONOMOUS',
  gates: {
    integrationCommand: 'bun test:integration',
    requiredChecks: ['CI gate', 'Playwright E2E'],
  },
  pagespace: {
    apiUrl: 'https://pagespace.ai',
    driveName: 'Offense Demo',
    driveId: fakeId('drive'),
    pages: ids('p', PAGE_KEYS),
    channels: ids('c', CHANNEL_KEYS),
    agents: ids('a', AGENT_KEYS),
  },
});

/** A validated, fully provisioned config for tests. */
export const provisionedConfig = (): ProjectConfig =>
  parseProjectConfig(provisionedConfigJson());

/** A validated config whose drive has not been bootstrapped (all ids null). */
export const unprovisionedConfig = (): ProjectConfig => {
  const raw = provisionedConfigJson();
  const nulls = (keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, null]));
  return parseProjectConfig({
    ...raw,
    pagespace: {
      ...raw.pagespace,
      driveId: null,
      pages: nulls(PAGE_KEYS),
      channels: nulls(CHANNEL_KEYS),
      agents: nulls(AGENT_KEYS),
    },
  });
};

/** The message a synchronous call throws, or `'no throw'`. */
export const thrown = (run: () => unknown): string => {
  try {
    run();
    return 'no throw';
  } catch (error) {
    return (error as Error).message;
  }
};

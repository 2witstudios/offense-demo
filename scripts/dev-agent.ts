import { agentSeedUsers, agentSeedVersion } from './agent-seed';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readEnvValue, withSlotEnv } from './slot-env';

const root = resolve(import.meta.dir, '..');

/**
 * Matches `apps/realtime/src/port.ts`'s `DEFAULT_REALTIME_PORT`. A root
 * script does not import across the app workspace boundary; instead
 * `dev-agent.test.ts` asserts this literal stays equal to that export.
 */
export const DEFAULT_REALTIME_PORT = 3011;

export type AgentCredential = {
  readonly username: string;
  readonly userId: string;
};

export type ReadinessOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
};

export function formatAgentReady({
  appUrl,
  realtimeUrl,
  credentials,
  seedVersion,
}: {
  readonly appUrl: string;
  readonly realtimeUrl: string;
  readonly credentials: readonly AgentCredential[];
  readonly seedVersion: string;
}): string {
  return [
    'Offense Demo agent development ready',
    `Web: ${appUrl}`,
    `Health: ${appUrl}/api/health/ready`,
    `Realtime: ${realtimeUrl}`,
    `Realtime health: ${realtimeUrl}/health/ready`,
    'Credentials:',
    ...credentials.map(({ username, userId }) => `  ${username} (${userId})`),
    `Seed version: ${seedVersion}`,
    '',
  ].join('\n');
}

export async function waitForReadiness(
  url: string,
  {
    fetch = globalThis.fetch,
    delay = (milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 60_000,
    intervalMs = 250,
  }: ReadinessOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // The web process may still be starting or compiling its first request.
    }
    if (Date.now() >= deadline)
      throw new Error(`Web readiness timed out after ${timeoutMs}ms`);
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

type Command = 'slot:up' | 'db:seed';

async function runCommand(
  command: Command,
  { quiet = false, env = process.env } = {},
): Promise<void> {
  const child = Bun.spawn(['bun', 'run', command], {
    cwd: root,
    env,
    stdin: 'inherit',
    stdout: quiet ? 'ignore' : 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(`${command} failed with exit code ${exitCode}`);
}

async function main(): Promise<void> {
  // slot:up brings the shared stack up, migrates this checkout's databases
  // and may rewrite .env. Bun loaded the old .env into this process, and
  // children inherit it over --env-file, so they get the fresh slot values.
  await runCommand('slot:up');
  const content = await readFile(resolve(root, '.env'), 'utf8');
  const env = withSlotEnv(process.env, content);
  await runCommand('db:seed', { quiet: true, env });

  const appUrl =
    readEnvValue(content, 'PUBLIC_APP_URL') ?? 'http://localhost:3000';
  const realtimeUrl = `http://localhost:${readEnvValue(content, 'REALTIME_PORT') ?? DEFAULT_REALTIME_PORT}`;
  // `bun run dev` (turbo) starts every workspace's dev task, web and
  // realtime alike; nothing here spawns apps/realtime separately.
  const web = Bun.spawn(['bun', 'run', 'dev'], {
    cwd: root,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const stopWeb = () => web.kill('SIGTERM');
  process.once('SIGINT', stopWeb);
  process.once('SIGTERM', stopWeb);
  try {
    await waitForReadiness(`${appUrl}/api/health/ready`);
    await waitForReadiness(`${realtimeUrl}/health/ready`);
    process.stdout.write(
      formatAgentReady({
        appUrl,
        realtimeUrl,
        credentials: agentSeedUsers,
        seedVersion: agentSeedVersion,
      }),
    );
    await web.exited;
  } finally {
    process.removeListener('SIGINT', stopWeb);
    process.removeListener('SIGTERM', stopWeb);
    if (web.exitCode === null) web.kill('SIGTERM');
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Agent development failed'}\n`,
    );
    process.exitCode = 1;
  }
}

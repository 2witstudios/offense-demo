/**
 * The environment variable that marks a fully autonomous agent run. It is a
 * constant rather than read from project.config.json at runtime, because the
 * shell launcher (scripts/agent-launch.sh), the repository hooks and
 * `.env.agent` all name it literally; project.config.json `autonomyEnv`
 * must equal it (agent-session.test.ts).
 */
export const AUTONOMY_ENV = 'AGENT_AUTONOMOUS';

/** Whether this process is a fully autonomous agent run (AGENT_AUTONOMOUS=1). */
export const sessionIsAgent = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => env[AUTONOMY_ENV] === '1';

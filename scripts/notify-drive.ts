#!/usr/bin/env bun
import { createHmac } from 'node:crypto';
import {
  driveProvisioned,
  driveSkipNotice,
  loadProjectConfig,
  repoUrl,
} from './project-config';
import { assessEventText } from './untrusted-text';

/**
 * A task code: prefix, number, sub-leaf levels (AUTH-2.2.1), a follow-up
 * letter (RT-2.2f) and a revision (RT-2.2f-r1).
 */
export const TASK_CODE = String.raw`[A-Z]{2,6}-\d+(?:\.\d+)*[a-z]?(?:-r\d+)?`;
// Whole codes only: never a shorter prefix of a longer code.
const TASK_ID_PATTERN = new RegExp(
  String.raw`\b${TASK_CODE}(?![\w]|\.\d|-r\d)`,
  'g',
);

// Prefixes that match the task-code shape but are never tasks: protocol and
// format names, ADR citations (ADR-0023), and model names (GLM-5.3), which PR
// bodies cite and which would otherwise reach documentation events.
export const TASK_ID_STOPWORDS: readonly string[] = [
  'ADR',
  'API',
  'ASCII',
  'CD',
  'CI',
  'CSS',
  'DOC',
  'FIXME',
  'GLM',
  'HTTP',
  'HTTPS',
  'IEEE',
  'ISO',
  'JSON',
  'OS',
  'PR',
  'RFC',
  'SHA',
  'SQL',
  'TODO',
  'URL',
  'UTF',
  'UUID',
];

export function extractTaskIds(text: string): string[] {
  return [...new Set(text.match(TASK_ID_PATTERN) ?? [])].filter(
    (taskId) => !TASK_ID_STOPWORDS.includes(taskId.split('-')[0]),
  );
}

export function signPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const message = `v0:${timestampSeconds}:${rawBody}`;
  return 'v0=' + createHmac('sha256', secret).update(message).digest('hex');
}

function taskList(taskIds: string[]): string {
  return taskIds.length > 0
    ? `Tasks: ${taskIds.join(', ')}`
    : 'Tasks: none referenced';
}

export function composeIncidentMessage(input: {
  ref: string;
  sha: string;
  runUrl: string;
  taskIds: string[];
}): string {
  return [
    `🔴 CI failed — offense-demo@${input.ref}`,
    input.runUrl,
    `commit ${input.sha}`,
    taskList(input.taskIds),
  ].join('\n');
}

// One `<job>.<step id>=<outcome>` pair; anything else is dropped unread so a
// malformed value can never reach the channel.
const STEP_OUTCOME =
  /^([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)=(success|failure|cancelled|skipped)?$/;

/** The first failed step in a deploy workflow's reported step outcomes. */
export function firstFailedStep(outcomes: string): string {
  for (const pair of outcomes.split(/\s+/)) {
    const match = pair.match(STEP_OUTCOME);
    if (match?.[2] === 'failure') return match[1];
  }
  return 'unknown';
}

export function composeDeployFailureMessage(input: {
  app: string;
  step: string;
  sha: string;
  runUrl: string;
}): string {
  return [
    `🔴 Deploy failed — ${input.app}`,
    input.runUrl,
    `Failing step: ${input.step}`,
    `commit ${input.sha}`,
  ].join('\n');
}

export function composeDocsFailureMessage(input: {
  pr: number;
  title?: string;
  url: string;
  skipped?: boolean;
  /** The repository's GitHub URL (`repoUrl(config)`), for the runbook link. */
  repoUrl: string;
}): string {
  const { title } = assessEventText({ title: input.title ?? '' });
  const summary = input.skipped
    ? `🟡 Documentation event skipped for merged fork PR #${input.pr} — replay manually with \`bun docs:dispatch\` from a trusted checkout.`
    : `🔴 Documentation event failed for #${input.pr}${title ? ` — ${title}` : ''}`;
  return [
    summary,
    input.url,
    input.skipped
      ? `${input.repoUrl}/blob/main/docs/operations/documentation-review-workflows.md`
      : 'Replay with `bun docs:dispatch` after fixing the workflow.',
  ].join('\n');
}

export function composeMergeMessage(input: {
  pr: number;
  title: string;
  url: string;
  sha: string;
  base: string;
  taskIds: string[];
}): string {
  return [
    `✅ Merged #${input.pr} — ${input.title}`,
    input.url,
    `${input.sha} → ${input.base}`,
    taskList(input.taskIds),
  ].join('\n');
}

export const CHANNELS = [
  'standup',
  'incidents',
  'sprint-room',
  'epic-updates',
] as const;
type Channel = (typeof CHANNELS)[number];

const CHANNEL_ENV: Record<Channel, { url: string; secret: string }> = {
  standup: {
    url: 'PAGESPACE_STANDUP_WEBHOOK_URL',
    secret: 'PAGESPACE_STANDUP_WEBHOOK_SECRET',
  },
  incidents: {
    url: 'PAGESPACE_INCIDENTS_WEBHOOK_URL',
    secret: 'PAGESPACE_INCIDENTS_WEBHOOK_SECRET',
  },
  'sprint-room': {
    url: 'PAGESPACE_SPRINT_ROOM_WEBHOOK_URL',
    secret: 'PAGESPACE_SPRINT_ROOM_WEBHOOK_SECRET',
  },
  'epic-updates': {
    url: 'PAGESPACE_EPIC_UPDATES_WEBHOOK_URL',
    secret: 'PAGESPACE_EPIC_UPDATES_WEBHOOK_SECRET',
  },
};

function requireHttpsWebhook(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https to protect the signed payload`);
  }
  return url;
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

/**
 * Each delivery attempt is abandoned after this long and counts as a
 * failed attempt, so a hung webhook cannot hold a caller (the AUTH-7.7
 * probe's job has a 5-minute limit) past its retries (ISSUE-208).
 */
export const NOTIFY_ATTEMPT_TIMEOUT_MS = 20_000;

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

export type DeliveryOptions = {
  readonly delays?: readonly number[];
  /** Per-attempt budget; `NOTIFY_ATTEMPT_TIMEOUT_MS` when omitted. */
  readonly attemptTimeoutMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
};

export async function deliverWithRetry(input: {
  readonly send: () => Promise<Response>;
  readonly delays?: readonly number[];
  readonly delay?: (ms: number) => Promise<void>;
}): Promise<Response> {
  const delays = input.delays ?? DEFAULT_RETRY_DELAYS_MS;
  const delay =
    input.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await input.send();
    } catch (error) {
      if (attempt >= delays.length)
        throw error instanceof Error ? error : new Error(String(error));
      await delay(delays[attempt]);
      attempt += 1;
      continue;
    }
    if (
      response.ok ||
      !isRetryableStatus(response.status) ||
      attempt >= delays.length
    )
      return response;
    await delay(delays[attempt]);
    attempt += 1;
  }
}

async function postSignedWebhook(input: {
  readonly label: string;
  readonly url: URL;
  readonly secret: string;
  readonly rawBody: string;
  readonly delivery?: DeliveryOptions;
}): Promise<Response> {
  const fetchImpl = input.delivery?.fetchImpl ?? fetch;
  return deliverWithRetry({
    delays: input.delivery?.delays,
    delay: input.delivery?.delay,
    send: async () => {
      const timestampSeconds = Math.floor(Date.now() / 1000);
      try {
        return await fetchImpl(input.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(
            input.delivery?.attemptTimeoutMs ?? NOTIFY_ATTEMPT_TIMEOUT_MS,
          ),
          headers: {
            'Content-Type': 'application/json',
            'x-pagespace-timestamp': String(timestampSeconds),
            'x-pagespace-signature': signPayload(
              input.secret,
              timestampSeconds,
              input.rawBody,
            ),
          },
          body: input.rawBody,
        });
      } catch (error) {
        throw new Error(
          `Webhook ${input.label} request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}

export async function postToDrive(
  channel: Channel,
  content: string,
  delivery?: DeliveryOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const rawUrl = env[CHANNEL_ENV[channel].url];
  const secret = env[CHANNEL_ENV[channel].secret];
  if (!rawUrl || !secret) {
    throw new Error(
      `Missing ${CHANNEL_ENV[channel].url} or ${CHANNEL_ENV[channel].secret}`,
    );
  }
  const url = requireHttpsWebhook(CHANNEL_ENV[channel].url, rawUrl);
  const rawBody = JSON.stringify({ content, username: 'Offense Demo CI' });
  const response = await postSignedWebhook({
    label: channel,
    url,
    secret,
    rawBody,
    delivery,
  });
  if (!response.ok) {
    throw new Error(
      `Webhook ${channel} responded ${response.status}: ${await response.text()}`,
    );
  }
}

function readFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || i + 1 >= args.length) {
      throw new Error(`Invalid flag near "${args[i]}"`);
    }
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [channel, ...rest] = process.argv.slice(2);
  // Nowhere to post: no drive yet and no webhook named for this channel.
  const webhook = CHANNELS.includes(channel as Channel)
    ? process.env[CHANNEL_ENV[channel as Channel].url]
    : undefined;
  if (!webhook && !driveProvisioned(loadProjectConfig())) {
    console.log(driveSkipNotice(`notify-drive ${channel ?? ''}`.trimEnd()));
    return;
  }
  if (!CHANNELS.includes(channel as Channel)) {
    throw new Error(`Channel must be one of: ${CHANNELS.join(', ')}`);
  }
  const flags = readFlags(rest);
  const taskIds = flags.tasks
    ? extractTaskIds(flags.tasks)
    : extractTaskIds(`${flags.ref ?? ''}`);

  let content: string;
  if (flags.message) {
    content = flags.message;
  } else if (channel === 'incidents' && flags.pr !== undefined) {
    content = composeDocsFailureMessage({
      pr: Number(requireFlag(flags, 'pr')),
      title: flags.title,
      url: requireFlag(flags, 'url'),
      skipped: flags.skipped === 'true',
      repoUrl: repoUrl(loadProjectConfig()),
    });
  } else if (channel === 'incidents' && flags.deploy !== undefined) {
    content = composeDeployFailureMessage({
      app: requireFlag(flags, 'deploy'),
      step: firstFailedStep(flags.outcomes ?? ''),
      sha: requireFlag(flags, 'sha'),
      runUrl: requireFlag(flags, 'run-url'),
    });
  } else if (channel === 'incidents') {
    content = composeIncidentMessage({
      ref: requireFlag(flags, 'ref'),
      sha: requireFlag(flags, 'sha'),
      runUrl: requireFlag(flags, 'run-url'),
      taskIds,
    });
  } else {
    content = composeMergeMessage({
      pr: Number(requireFlag(flags, 'pr')),
      title: requireFlag(flags, 'title'),
      url: requireFlag(flags, 'url'),
      sha: requireFlag(flags, 'sha'),
      base: requireFlag(flags, 'base'),
      taskIds,
    });
  }

  await postToDrive(channel as Channel, content);
  console.log(`Posted to ${channel}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}

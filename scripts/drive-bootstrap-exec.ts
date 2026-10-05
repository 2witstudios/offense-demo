/**
 * The effectful half of `bun drive:bootstrap`: executes a plan through the
 * injected transport (PageSpace HTTP API, child processes, files) so tests
 * drive it with fakes. Every new id is written to `project.config.json` the
 * moment it exists, so a crash resumes where it stopped.
 */
import { DOCUMENT_PIPELINES, type DocumentPipeline } from './docs-pipeline';
import { promptFor } from './docs-prompts';
import {
  HttpError,
  templateVars,
  type Paths,
  type Transport,
} from './drive-bootstrap-inspect';
import type { ConfigSlot, Manifest } from './drive-bootstrap-manifest';
import {
  formatOf,
  mergeEnv,
  renderAgentsDrive,
  resolvePlaceholders,
  setConfigId,
  type RenderContext,
} from './drive-bootstrap-render';
import {
  AGENT_ROLE,
  webhookEnv,
  type Action,
  type ExistingState,
} from './drive-bootstrap-plan';
import { parseProjectConfig } from './project-config';

export type ExecContext = {
  readonly manifest: Manifest;
  readonly transport: Transport;
  readonly paths: Paths;
  /** What inspection found: existing node ids, the drive, the Agent role. */
  readonly state: ExistingState;
};

type Run = {
  readonly ctx: ExecContext;
  readonly ids: Record<string, string>;
  driveId: string | null;
  agentRoleId: string | null;
  configText: string;
};

const idOf = (run: Run, ref: string): string => {
  const id = run.ids[ref];
  if (!id) throw new Error(`${ref} has no id yet`);
  return id;
};
const requireDrive = (run: Run): string => {
  if (!run.driveId) throw new Error('No drive id yet');
  return run.driveId;
};

function record(run: Run, slot: ConfigSlot | 'drive', id: string): void {
  run.configText = setConfigId(run.configText, slot, id);
  parseProjectConfig(JSON.parse(run.configText));
  run.ctx.transport.writeText(run.ctx.paths.config, run.configText);
}

function render(run: Run, file: string, format = formatOf(file)): string {
  const text = run.ctx.transport.readText(`${run.ctx.paths.seed}/${file}`);
  if (text === null) throw new Error(`drive-seed/${file} is missing`);
  const config = parseProjectConfig(JSON.parse(run.configText));
  const context: RenderContext = {
    vars: templateVars(config, run.driveId),
    driveId: run.driveId,
    pages: Object.fromEntries(
      run.ctx.manifest.nodes.map((node) => [
        node.ref,
        { id: run.ids[node.ref] ?? null, title: node.title },
      ]),
    ),
  };
  return resolvePlaceholders(text, context, format);
}

function writeEnv(run: Run, updates: Record<string, string>): void {
  const { transport, paths } = run.ctx;
  const { text, keys } = mergeEnv(transport.readText(paths.env) ?? '', updates);
  transport.writeText(paths.env, text);
  transport.log(`  wrote ${keys.join(', ')} to .env`);
}

async function githubSecrets(
  run: Run,
  secrets: Record<string, string>,
): Promise<void> {
  const repo = parseProjectConfig(JSON.parse(run.configText)).repo;
  for (const [name, value] of Object.entries(secrets)) {
    const result = await run.ctx.transport.run(
      ['gh', 'secret', 'set', name, '--repo', repo],
      { stdin: value },
    );
    if (result.code !== 0)
      throw new Error(`gh secret set ${name} failed (exit ${result.code})`);
    run.ctx.transport.log(`  set GitHub secret ${name}`);
  }
}

const COLUMNS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function createWebhook(
  run: Run,
  ref: string,
  envStem: string,
  github: boolean,
): Promise<void> {
  const config = parseProjectConfig(JSON.parse(run.configText));
  let created: { webhook: { webhookToken: string }; webhookSecret: string };
  try {
    created = await run.ctx.transport.api(
      'POST',
      `/api/pages/${idOf(run, ref)}/webhooks`,
      { name: `${config.name} CI` },
    );
  } catch (error) {
    if (error instanceof HttpError && [401, 403].includes(error.status))
      throw new Error(
        `Creating the ${ref} webhook was refused (${error.status}). Webhooks need the drive owner or an admin through an UNSCOPED key: ` +
          'mint one with `pagespace keys create --all-drives --name <name>-bootstrap --show-token`, export it as PAGESPACE_BOOTSTRAP_TOKEN and rerun, ' +
          'or create the webhook in the channel settings and put its URL and secret in .env yourself.',
      );
    throw error;
  }
  const env = webhookEnv(envStem);
  const values = {
    [env.url]: `${config.pagespace.apiUrl}/api/webhooks/${created.webhook.webhookToken}`,
    [env.secret]: created.webhookSecret,
  };
  writeEnv(run, values);
  if (github) await githubSecrets(run, values);
}

async function ensureAgentRole(run: Run, roleId: string | null): Promise<void> {
  const driveId = requireDrive(run);
  const driveWidePermissions = {
    canView: AGENT_ROLE.view,
    canEdit: AGENT_ROLE.edit,
    canShare: AGENT_ROLE.share,
  };
  if (roleId === null) {
    const created = await run.ctx.transport.api<{ role: { id: string } }>(
      'POST',
      `/api/drives/${driveId}/roles`,
      {
        name: AGENT_ROLE.name,
        description: AGENT_ROLE.description,
        permissions: {},
        driveWidePermissions,
      },
    );
    run.agentRoleId = created.role.id;
  } else {
    await run.ctx.transport.api(
      'PATCH',
      `/api/drives/${driveId}/roles/${roleId}`,
      { driveWidePermissions },
    );
    run.agentRoleId = roleId;
  }
}

async function mintKey(
  run: Run,
  action: Extract<Action, { kind: 'mintKey' }>,
): Promise<void> {
  const config = parseProjectConfig(JSON.parse(run.configText));
  if (!run.agentRoleId)
    throw new Error(`The drive has no "${AGENT_ROLE.name}" role to mint with`);
  const command = [
    'pagespace',
    'keys',
    'create',
    '--drive',
    requireDrive(run),
    '--role',
    run.agentRoleId,
    '--name',
    `${config.name}-agent`,
    '--show-token',
    '--host',
    config.pagespace.apiUrl,
  ];
  run.ctx.transport.log('  approve the key in your browser…');
  const result = await run.ctx.transport.run(command);
  const token = /^PAGESPACE_TOKEN=(mcp_\S+)$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || !token)
    throw new Error(
      `pagespace keys create failed (exit ${result.code}); no token was printed`,
    );
  writeEnv(run, { PAGESPACE_TOKEN: token });
  if (action.github) await githubSecrets(run, { PAGESPACE_TOKEN: token });
  if (action.replaces)
    run.ctx.transport.log(
      '  the replaced key still exists: revoke it (`pagespace keys list`, then `pagespace keys revoke`)',
    );
}

async function createWorkflow(
  run: Run,
  action: Extract<Action, { kind: 'createWorkflow' }>,
): Promise<void> {
  const { pipeline } = action.workflow;
  if (!DOCUMENT_PIPELINES.includes(pipeline as DocumentPipeline))
    throw new Error(`Unknown docs pipeline ${pipeline}`);
  const agent = run.ctx.manifest.nodes.find(
    (node) =>
      node.config?.group === 'agents' && node.config.key === 'documentation',
  );
  const context = run.ctx.manifest.nodes.filter(
    (node) => node.parent === 'documentation' || node.ref === 'documentation',
  );
  const { version, prompt } = promptFor(pipeline as DocumentPipeline);
  await run.ctx.transport.api('POST', '/api/workflows', {
    driveId: requireDrive(run),
    name: action.workflow.name,
    agentPageId: idOf(run, agent?.ref ?? ''),
    prompt: `Scheduled ${pipeline} run (prompt ${version}).\n\n${prompt}`,
    contextPageIds: context.map((node) => idOf(run, node.ref)).slice(0, 10),
    cronExpression: action.workflow.cron,
    timezone: 'UTC',
  });
}

async function structure(run: Run, action: Action): Promise<boolean> {
  const { transport } = run.ctx;
  if (action.kind === 'createDrive') {
    const drive = await transport.api<{ id: string }>('POST', '/api/drives', {
      name: action.name,
    });
    run.driveId = drive.id;
    record(run, 'drive', drive.id);
  } else if (action.kind === 'createPage') {
    const page = await transport.api<{ id: string }>('POST', '/api/pages', {
      driveId: requireDrive(run),
      title: action.title,
      type: action.type,
      parentId: action.parent === null ? null : idOf(run, action.parent),
      ...(action.contentMode ? { contentMode: action.contentMode } : {}),
    });
    run.ids[action.ref] = page.id;
    if (action.slot) record(run, action.slot, page.id);
  } else if (action.kind === 'createTask') {
    const task = await transport.api<{ pageId: string }>(
      'POST',
      `/api/pages/${idOf(run, action.parent)}/tasks`,
      { title: action.title, status: 'pending' },
    );
    run.ids[action.ref] = task.pageId;
    if (action.slot) record(run, action.slot, task.pageId);
  } else if (action.kind === 'recordId') {
    record(run, action.slot, action.id);
  } else return action.kind === 'keep';
  return true;
}

async function seed(run: Run, action: Action): Promise<boolean> {
  const { transport } = run.ctx;
  if (action.kind === 'seedContent') {
    await transport.api('PATCH', `/api/pages/${idOf(run, action.ref)}`, {
      content: render(run, action.file),
    });
  } else if (action.kind === 'createStatus') {
    try {
      await transport.api(
        'POST',
        `/api/pages/${idOf(run, action.ref)}/tasks/statuses`,
        action.preset,
      );
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409)) throw error;
    }
  } else if (action.kind === 'writeHeader') {
    const cells = action.header.map((value, index) => ({
      address: `${COLUMNS[index]}1`,
      value,
    }));
    await transport.api('POST', '/api/mcp/sheets', {
      operation: 'update-cells',
      pageId: idOf(run, action.ref),
      cells,
    });
  } else if (action.kind === 'configureAgent') {
    const { agent } = action;
    await transport.api(
      'PUT',
      `/api/ai/page-agents/${idOf(run, action.ref)}/config`,
      {
        systemPrompt: render(run, agent.systemPrompt, 'text'),
        enabledTools: [...agent.enabledTools],
        aiProvider: agent.aiProvider,
        aiModel: agent.aiModel,
      },
    );
  } else return false;
  return true;
}

async function settle(run: Run, action: Action): Promise<void> {
  const { transport, paths } = run.ctx;
  if (action.kind === 'setDriveContext') {
    const drivePrompt = render(run, action.file, 'text').trim();
    if (drivePrompt.length > 10_000)
      throw new Error('Drive context exceeds 10000 characters');
    await transport.api('PATCH', `/api/drives/${requireDrive(run)}`, {
      drivePrompt,
    });
  } else if (action.kind === 'setHomePage') {
    await transport.api('PATCH', `/api/drives/${requireDrive(run)}`, {
      homePageId: idOf(run, action.ref),
    });
  } else if (action.kind === 'createWebhook') {
    await createWebhook(run, action.ref, action.envStem, action.github);
  } else if (action.kind === 'ensureAgentRole') {
    await ensureAgentRole(run, action.roleId);
  } else if (action.kind === 'mintKey') {
    await mintKey(run, action);
  } else if (action.kind === 'createWorkflow') {
    await createWorkflow(run, action);
  } else if (action.kind === 'renderAgentsMd') {
    const text = transport.readText(paths.agents) ?? '';
    const conventions = run.ctx.manifest.nodes.find(
      (node) => node.config?.key === 'conventions',
    );
    const config = parseProjectConfig(JSON.parse(run.configText));
    const rendered = renderAgentsDrive(text, {
      driveName: config.pagespace.driveName,
      driveId: run.driveId,
      conventionsId: conventions ? (run.ids[conventions.ref] ?? null) : null,
    });
    if (!rendered.found)
      transport.log(
        '  AGENTS.md has no <!-- drive:start --> / <!-- drive:end --> markers; left unchanged',
      );
    else if (rendered.text !== text)
      transport.writeText(paths.agents, rendered.text);
  }
}

/** Runs the plan in order; stops at the first failure with ids already saved. */
export async function executePlan(
  actions: readonly Action[],
  ctx: ExecContext,
): Promise<void> {
  const configText = ctx.transport.readText(ctx.paths.config);
  if (configText === null) throw new Error('project.config.json is missing');
  const run: Run = {
    ctx,
    ids: Object.fromEntries(
      Object.entries(ctx.state.nodes).map(([ref, node]) => [ref, node.id]),
    ),
    driveId: ctx.state.drive?.id ?? null,
    agentRoleId: ctx.state.agentRole?.id ?? null,
    configText,
  };
  // Kept nodes are bookkeeping, not work: number only the real actions.
  const total = actions.filter((action) => action.kind !== 'keep').length;
  let step = 0;
  for (const action of actions) {
    if (action.kind !== 'keep') {
      step += 1;
      ctx.transport.log(
        `[${step}/${total}] ${action.kind} ${'ref' in action ? action.ref : ''}`.trimEnd(),
      );
    }
    if (await structure(run, action)) continue;
    if (await seed(run, action)) continue;
    await settle(run, action);
  }
}

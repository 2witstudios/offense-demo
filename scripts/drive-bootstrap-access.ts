/**
 * The agent's access, the last read of `bun drive:bootstrap`: the drive's
 * custom "Agent" role and whether `.env`'s PAGESPACE_TOKEN holds it and can
 * edit. A key minted with the built-in MEMBER role reads fine and fails
 * every board write, so this asks PageSpace's own resolver rather than
 * trusting the role name. GETs only, so `--check` runs it read-only.
 */
import {
  HttpError,
  inspectDrive,
  type InspectOptions,
  type Inspection,
  type Problem,
  type Transport,
} from './drive-bootstrap-inspect';
import type { Manifest } from './drive-bootstrap-manifest';
import {
  AGENT_ROLE,
  grantsAgentAccess,
  type RoleState,
} from './drive-bootstrap-plan';
import type { ProjectConfig } from './project-config';

type RoleRecord = {
  readonly id: string;
  readonly name: string;
  readonly driveWidePermissions: {
    readonly canView: boolean;
    readonly canEdit: boolean;
    readonly canShare: boolean;
  } | null;
};

/** The drive's "Agent" role (found by name: names are unique per drive). */
async function agentRole(
  transport: Transport,
  driveId: string,
): Promise<RoleState | null> {
  const { roles } = await transport.api<{ roles: readonly RoleRecord[] }>(
    'GET',
    `/api/drives/${driveId}/roles`,
  );
  const role = roles.find((candidate) => candidate.name === AGENT_ROLE.name);
  if (!role) return null;
  const grant = role.driveWidePermissions;
  return {
    id: role.id,
    view: grant?.canView ?? false,
    edit: grant?.canEdit ?? false,
    share: grant?.canShare ?? false,
  };
}

function roleProblems(role: RoleState | null): Problem[] {
  const ref = 'agentRole';
  if (role === null)
    return [{ ref, message: `drive role "${AGENT_ROLE.name}" is missing` }];
  return grantsAgentAccess(role)
    ? []
    : [
        {
          ref,
          message: `drive role "${AGENT_ROLE.name}" ${role.id} grants view=${role.view} edit=${role.edit} share=${role.share}; expected view=true edit=true share=false`,
        },
      ];
}

type KeyDescription = {
  readonly driveScopes: readonly {
    readonly id: string;
    readonly customRoleId: string | null;
  }[];
  readonly page: {
    readonly permissions: { readonly canEdit: boolean } | null;
  } | null;
};

const KEY_FIX =
  'rerun `bun drive:bootstrap` to mint a key with the Agent role, then revoke the old one (`pagespace keys list`, `pagespace keys revoke`)';

/**
 * Asks PageSpace what `.env`'s PAGESPACE_TOKEN may do on the Roadmap
 * (`GET /api/auth/key`, the server's own resolver): it must hold the Agent
 * role and be able to edit, or every board write fails.
 */
async function agentKeyProblems(
  agentKey: Transport,
  driveId: string,
  roadmapId: string,
  role: RoleState | null,
): Promise<Problem[]> {
  const fail = (message: string): Problem[] => [
    { ref: 'PAGESPACE_TOKEN', message: `${message}: ${KEY_FIX}` },
  ];
  let described: KeyDescription;
  try {
    described = await agentKey.api<KeyDescription>(
      'GET',
      `/api/auth/key?pageId=${roadmapId}`,
    );
  } catch (error) {
    if (error instanceof HttpError && [401, 403].includes(error.status))
      return fail(`was refused (${error.status})`);
    throw error;
  }
  const scope = described.driveScopes.find((drive) => drive.id === driveId);
  if (!described.page?.permissions?.canEdit)
    return fail('cannot edit the Roadmap');
  if (role === null || scope?.customRoleId !== role.id)
    return fail(`does not hold the "${AGENT_ROLE.name}" role`);
  return [];
}

/** The Agent role, and whether `.env`'s key holds it and can edit (null: unverified). */
async function agentAccess(
  transport: Transport,
  agentKey: Transport | null,
  driveId: string,
  roadmapId: string | undefined,
  env: ReadonlySet<string>,
): Promise<{
  role: RoleState | null;
  keyValid: boolean | null;
  problems: Problem[];
}> {
  const role = await agentRole(transport, driveId);
  const keyProblems =
    agentKey && roadmapId
      ? await agentKeyProblems(agentKey, driveId, roadmapId, role)
      : null;
  const missing: Problem[] = env.has('PAGESPACE_TOKEN')
    ? []
    : [
        {
          ref: 'PAGESPACE_TOKEN',
          message: 'is not set in .env: rerun `bun drive:bootstrap` to mint it',
        },
      ];
  return {
    role,
    keyValid: keyProblems === null ? null : keyProblems.length === 0,
    problems: [...roleProblems(role), ...missing, ...(keyProblems ?? [])],
  };
}

/**
 * `inspectDrive`, then the Agent role and key on the drive it found.
 * `agentKey` is a transport authenticated with `.env`'s PAGESPACE_TOKEN.
 */
export async function inspectBootstrap(
  config: ProjectConfig,
  manifest: Manifest,
  transport: Transport,
  options: InspectOptions & { readonly agentKey: Transport | null },
): Promise<Inspection> {
  const inspected = await inspectDrive(config, manifest, transport, options);
  const { state } = inspected;
  if (state.drive === null) return inspected;
  const access = await agentAccess(
    transport,
    options.agentKey,
    state.drive.id,
    state.nodes.roadmap?.id,
    state.env,
  );
  return {
    state: { ...state, agentRole: access.role, agentKeyValid: access.keyValid },
    problems: [...inspected.problems, ...access.problems],
  };
}

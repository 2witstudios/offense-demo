#!/bin/sh
# pu agent launcher. .pu/config.yaml runs every agent through this
# script: it exports the machine identity from .env.agent and then becomes
# the agent, so gh and git never act as the owner.
#
# The identity regime is on once the owner's .env.agent exists in the project
# root ($PU_PROJECT_ROOT, the main checkout). Then an invalid identity refuses
# the start. Before that (GRD-6.2) agents start as they always have, with a
# warning, and bun doctor warns too.
set -eu

env_file=""
if [ -n "${PU_PROJECT_ROOT:-}" ] && [ -f "$PU_PROJECT_ROOT/.env.agent" ]; then
  env_file="$PU_PROJECT_ROOT/.env.agent"
elif [ -f ./.env.agent ]; then
  env_file=./.env.agent
fi

# pu's terminal agent type passes "shell": a login shell under the identity.
if [ "${1:-}" = shell ]; then
  shift
  set -- "${SHELL:-/bin/sh}" -l "$@"
fi

if [ -z "$env_file" ]; then
  echo "agent-launch: identity regime not active: this agent acts as the owner (GRD-6.2)." >&2
  exec "$@"
fi
# The validated values are exported literally; .env.agent is never sourced,
# so nothing in it is expanded by the shell.
exports=$(bun "$(dirname "$0")/agent-identity.ts" export-env "$env_file")
eval "$exports"
# The owner's login environment must not leak its credentials to the agent.
unset GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN SSH_AUTH_SOCK
exec "$@"

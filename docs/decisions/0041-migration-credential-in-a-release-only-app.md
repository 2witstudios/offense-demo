# 0041: The migration credential lives in a release-only Fly app

Status: accepted (builder decision under the prompt,
pending owner confirmation of the Fly steps it hands over).
Refines the owner/runtime credential split (ADR 0038 consequences).

## Context

An earlier change split the database credentials: the release command migrates as
the schema owner through `MIGRATION_DATABASE_URL`, and the web app serves
as the DML-only `offense_demo_web` through `DATABASE_URL`. Both were secrets of
the one Fly app `offense-demo-staging`.

Fly secrets belong to the whole app. Fly's secrets documentation says an
app's secrets "are available as environment variables at runtime on every
Machine belonging to that Fly App", and the `release_command` reference
says the temporary release machine "inherits environment, secrets, and
network config" (docs.fly.io/apps/secrets, docs.fly.io/reference/configuration,
read on 2026-09-24 against flyctl v0.4.105). No setting limits a secret to
the release command, to a process group or to one machine. So the owner
credential sat in every web machine's environment. The app never read it,
but any disclosure of the web process environment (a debug endpoint, a
crash dump, `/proc/self/environ` read through a path bug) would hand over
the schema owner. The split was meant to keep that credential away from the
runtime.

Options considered:

1. **Delete the variable from `process.env` at web startup.** This does not
   remove it from the machine: `fly ssh console` shells,
   `/proc/<pid>/environ` and any child process started before the delete
   still see it. It narrows the exposure but does not remove it.
2. **Scope the secret to the release command.** Fly offers no such
   setting. Secrets mounted as files (`[[files]]`) are still injected as
   environment variables everywhere.
3. **Have the release step fetch the credential from a store only it can
   read.** Every identity the release machine has is also held by the web
   machines: same app, same secrets, same image. `RELEASE_COMMAND=1` is an
   environment flag, not an identity. This option needs a second
   identity, which is option 4 under another name.
4. **A separate Fly app whose only job is the release.** Secrets are
   app-wide, so a second app is the boundary Fly actually enforces.

## Decision

1. **`offense-demo-staging-migrate` holds the owner credential and nothing
   else.** It is defined by `fly.migrate.toml`: the web image (built from
   `apps/web/Dockerfile` at the same commit), a `[deploy] release_command`
   running `packages/db/scripts/migrate.ts`, and no services and no process
   groups. `MIGRATION_DATABASE_URL` is its only secret.
2. **The migrator app never runs a machine of its own.** The staging
   workflow deploys it with `flyctl deploy -c fly.migrate.toml --update-only`,
   which runs the release command and creates no machines. Fly destroys the
   release machine when the command exits. That temporary machine is the
   only place the owner credential is ever loaded.
3. **The migrator deploys first, and a failure stops the release.** The
   web deploy is a later step in the same job. A failed migration, including
   one that hits the migrator's lock bound, fails the job
   before the web app changes, as Fly's `release_command` did before.
4. **The web app has no release command and no owner credential.**
   `fly.toml` has no `[deploy] release_command`. Production web and
   realtime startup refuse to run when `MIGRATION_DATABASE_URL` is in their
   environment (`requireDeploymentIdentity` in `packages/config`). A
   misplaced secret therefore fails the release loudly and never serves
   quietly.
5. **Each app has its own deploy token.** The migrator's token
   (`FLY_MIGRATE_API_TOKEN`) is scoped to the migrator app and exposed only
   on the workflow's migrate step (ADR 0040). The web token cannot deploy
   the migrator, and the migrator token cannot deploy the web app.
6. **`scripts/verify-deploy-config.ts` holds these rules in place.** It
   requires the release command in `fly.migrate.toml` and forbids it in
   `fly.toml`. It forbids services and process groups in the migrator
   config and database URLs in either `[env]`. It also requires the
   workflow to run the migrator deploy, with `--update-only`, before the
   web deploy.

## Consequences

- Each staging deploy builds the image twice, once per app, from the same
  commit. Fly's remote builder is per organization, so the second build
  reuses cached layers. Sharing one image across apps would need a registry
  pull between apps, which this decision does not rely on.
- The owner must create the migrator app and its token, move the secret,
  and rotate the owner password, because the old value sat on web
  machines. Agents never do these steps. The exact commands are
  in [deploy-staging](../operations/deploy-staging.md). Until the owner
  does them, the next staging deploy fails at the migrate step (the
  migrator app does not exist) or at web startup (the web app still holds
  `MIGRATION_DATABASE_URL`). Neither failure serves traffic with the
  credential exposed.
- `fly deploy --update-only` against an app with no machines is expected to
  run the release command and create nothing. The owner confirms this on
  the first run with `fly machines list -a offense-demo-staging-migrate`,
  which must list no machines.
- A production deployment follows the same shape: one runtime app per
  service and one release-only migrator app per environment.

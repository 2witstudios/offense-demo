# Local development

Prerequisites: Bun 1.4.2 (`.bun-version` pins it), Docker with Compose, Node
24 (Playwright driver only), PostgreSQL/Redis via the provided Compose stack.

```sh
git clone <repo> && cd offense-demo
bun install --frozen-lockfile
cp .env.example .env
bun dev:agent       # slot:up, deterministic seed, web and realtime, readiness
```

`bun dev:agent` is the clean-environment path. It runs `bun slot:up` (shared
PostgreSQL and Redis, this checkout's dev and test databases, migrations),
upserts the fixed local seed and its durable version marker, launches the
web and realtime (ADR 0031) development tasks, waits for web's
`/api/health/ready` and realtime's own `/health/ready`, and prints the web
URL, the realtime URL, seeded development identities, and seed version. It
does not print database URLs or passwords. Use `bun dev` when `bun slot:up`
has already run; it also migrates the test database, so integration tests
need nothing more: every `bun test:integration` run makes, migrates and drops a
database of its own from it (ADR 0034), and a suite started by hand with
`bun test` is refused. `apps/realtime` listens on `REALTIME_PORT` (default
`3011` in the main checkout; `bun slot:up` derives a worktree's own value),
distinct from the web app's `PORT` so both can run at once; it has no
handler logic yet beyond rejecting every connection.

## Commands

| Command                                                       | What it does                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun dev`                                                     | All dev processes (the web app and apps/realtime) via turbo                                                                                             |
| `bun dev:agent`                                               | Run `slot:up`, seed, launch web and realtime, and wait ready                                                                                            |
| `bun build`                                                   | Production builds through the turbo graph                                                                                                               |
| `bun test`                                                    | Fast deterministic unit/domain tests; no services or Next boot                                                                                          |
| `bun test:integration`                                        | Database, Redis, and web vertical tests against real services, each run in its own Postgres database, dropped after it (ADR 0034)                       |
| `bun visual:server`                                           | Linux Playwright browser server for screenshot parity on non-Linux hosts (see testing)                                                                  |
| `bun test:e2e`                                                | Playwright against the production server build                                                                                                          |
| `bun verify`                                                  | `bun check` plus migration-idempotency, integration, and E2E gates                                                                                      |
| `bun lint`                                                    | ESLint (incl. Tailwind token rules), `scripts/check-boundaries.ts`, and `scripts/check-styling.ts`                                                      |
| `bun format` / `bun format:check`                             | Prettier write / verify                                                                                                                                 |
| `bun typecheck`                                               | `tsc --noEmit` per workspace (web runs `next typegen` first)                                                                                            |
| `bun check`                                                   | format:check + lint + policy + knip + duplication + invariants + evidence + typecheck + test + metrics + build — before pushing; needs network, `gh`    |
| `bun check:affected`                                          | Fast per-vertical inner loop: lint/prettier on changed files, boundaries, duplication, affected turbo graph                                             |
| `bun hooks:install`                                           | One-time opt-in: point `core.hooksPath` at `.githooks` so `git push` runs `bun check:affected`                                                          |
| `bun migrations:check`                                        | Fail stray or orphaned migration files, a broken snapshot chain, or a branch that rewrites/edits/reorders shared migrations vs `origin/main` (ADR 0038) |
| `bun run duplication`                                         | Copy-paste tripwire (jscpd): fails on any clone absent from `.jscpd-baseline.json` (ADR 0026)                                                           |
| `bun evidence`                                                | Orphan-suite and CI-wiring audit: every test tier is claimed by a real runner                                                                           |
| `bun db:generate`                                             | Generate migration SQL from schema changes (review the SQL!)                                                                                            |
| `bun db:migrate`                                              | Apply pending migrations                                                                                                                                |
| `bun db:seed`                                                 | Development fixture: idempotently upsert the agent users and any product seed rows, mark its version (reference data comes from migrations)             |
| `bun db:studio`                                               | Drizzle Studio (local only, never expose)                                                                                                               |
| `bun slot:up`                                                 | Shared stack up, prune orphans, create and migrate this checkout's three databases, provision the e2e login, write `.env` slot values (idempotent)      |
| `bun slot:reset-e2e`                                          | Empty this checkout's e2e database back to the baseline and delete its e2e Redis keys                                                                   |
| `bun slot:down` / `bun slot:prune`                            | Drop this worktree's databases and Redis keys / those of worktrees git no longer lists                                                                  |
| `bun db:reset`                                                | Recreate and re-migrate this checkout's dev or test database and re-provision the e2e login (`ALLOW_DATABASE_RESET=yes`)                                |
| `bun db:roles`                                                | Provision the test logins on a loopback `DATABASE_URL` (CI; `slot:up` and `db:reset` already do it)                                                     |
| `bun infra:logs`                                              | Follow the shared stack's Compose logs                                                                                                                  |
| `bun adr:next`                                                | Next ADR number free across origin/main and every open PR                                                                                               |
| `bun github:rules [--apply]`                                  | Diff the committed main ruleset and repository settings against GitHub; `--apply` is owner-only                                                         |
| `bun board:read` / `status` / `create` / `relate` / `replace` | PageSpace board operations: raw reads, task status (never Done for agents), leaves and ISSUE-n, Related pages, hash-guarded replaces (`board:hash`)     |
| `bun board:stale [--apply]`                                   | List tasks whose status disagrees with git; `--apply` moves them to their pre-Done status                                                               |
| `bun decision:record`                                         | Record a decision made on the owner's behalf on Pending decisions and notify the owner                                                                  |
| `bun plan:review <plan>`                                      | Automated Codex review of a plan against AGENTS.md and the ADRs, before tasking                                                                         |

## Environment

`.env` (git-ignored) mirrors `.env.example`. Server configuration is parsed
by `@offense-demo/config` and fails fast on invalid or insecure values — production
refinements reject HTTP public URLs, development credentials, missing
deployment identity, and the development-only proof flag. The Compose
PostgreSQL is exposed on host port `15432` to coexist with host-level
Postgres installs; `.env.example` holds the main checkout's slot values and
`bun slot:up` rewrites them in a worktree.

Authentication variables (`BETTER_AUTH_SECRET`, `RECIPIENT_HASH_SECRET`,
`RESEND_API_KEY`, `AUTH_EMAIL_FROM`) are documented in `.env.example` and
validated only when the auth composition activates — baseline startup and
`bun doctor` never require them. `RECIPIENT_HASH_SECRET` keys the
suppression ledger and per-recipient rate-limit buckets independently of
`BETTER_AUTH_SECRET` (ADR 0044), so a session-secret rotation
never desynchronizes them. Run `bun auth:provision` to generate a
64-character value into `.env` for each of `BETTER_AUTH_SECRET` and
`RECIPIENT_HASH_SECRET` whenever its canonical `<NAME>=<value>` assignment
is missing. A canonical value is always preserved; non-canonical but
loader-supported assignments (`export BETTER_AUTH_SECRET=…`,
`BETTER_AUTH_SECRET = …`) rotate: the generated value is appended as the
final assignment (dotenv last-assignment semantics), the stale line is left
untouched, and repeated runs are no-ops. Neither value is ever printed or
committed. Resend is optional locally: without `RESEND_API_KEY` and
`AUTH_EMAIL_FROM`, `bun dev` prints auth mail to the terminal (see
[Signing in locally](#signing-in-locally)). Live email delivery needs
owner-provisioned Resend credentials. The optional
`AUTH_TRUSTED_PROXIES` list declares which of your own reverse proxy's IPs
or CIDR ranges to skip when walking a forwarded chain; leave it unset
locally (`next dev` runs without the stamping ingress, so no request carries
an identity anyway, and every request shares one rate-limit bucket per
path). See [production operations](../operations/production.md#releases).

## Signing in locally

You do not need a Resend account to sign in on your own machine.

1. `bun auth:provision` (generates `BETTER_AUTH_SECRET` and
   `RECIPIENT_HASH_SECRET` into `.env`), then `bun slot:up`.
2. Leave `RESEND_API_KEY` and `AUTH_EMAIL_FROM` unset, keep
   `PUBLIC_APP_URL` on `localhost`, and run `bun dev`.
3. Request a sign-in link on the sign-in page. The email is not sent.
   Instead, the terminal running `bun dev` prints it as a block of
   `[dev-mail]` lines, with the link on the `Link:` line.
4. Open that link to finish signing in. You can register a passkey from
   there.

The terminal mailer is selected only when `NODE_ENV=development`, the
hostname of `PUBLIC_APP_URL` is `localhost`, `127.0.0.1` or `[::1]`, and both
Resend variables are unset. Test and production builds, and a development
server on any other origin, refuse to start auth without Resend. The printed
link is a live credential: it is written to stderr only, never to the
structured logs ([ADR 0050](../decisions/0050-local-development-terminal-mailer.md)).
To send real mail, set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` (a verified
Resend sender). With both set, Resend is always used.

## Parallel sessions on one machine

Every checkout on the machine (the main checkout and each git worktree or
`pu` slot) uses the same local stack: one Postgres on `15432`, one Redis on
`6379`, Compose project `offense-demo`. What separates sessions is the **slot**,
which `bun slot:up` derives from the checkout folder
([ADR 0034](../decisions/0034-shared-stack-slots.md)):

| Checkout                      | Databases                                                                                   | Redis namespaces                                           | Ports (app, e2e)               | Realtime (dev, e2e)            |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ | ------------------------------ |
| Main checkout                 | `offense-demo`, `offense_demo_test`, `offense_demo_e2e`                                     | `offense-demo`, `offense-demo-e2e`                         | 3000, 3100                     | 3011, 3103                     |
| Worktree folder `wt-3ctbm0tw` | `offense_demo_wt_3ctbm0tw`, `offense_demo_wt_3ctbm0tw_test`, `offense_demo_wt_3ctbm0tw_e2e` | `offense-demo-wt-3ctbm0tw`, `offense-demo-wt-3ctbm0tw-e2e` | 13000+10n, 13001+10n (block n) | 13005+10n, 13004+10n (block n) |

### Running beside another project

Projects generated from this template each run their own stack, so two of
them (or this one and anything else on `15432`/`6379`/`3000`) collide on
host ports. Set these in `.env` (or the environment) and `bun slot:up`
moves everything to match; the setup wizard writes them for you when the
defaults are taken:

- `OFFENSE_DEMO_POSTGRES_PORT`, `OFFENSE_DEMO_REDIS_PORT`: the host ports
  `infra/compose.yaml` publishes; the stack URLs move with them.
- `OFFENSE_DEMO_APP_PORT`: the main checkout's app port; realtime follows at
  `+11` and the browser suite at `+100`…`+103`.

In a new worktree, copy the main checkout's `.env` (or `.env.example`) and
run `bun slot:up`. It is idempotent:

- starts the shared stack (`docker compose up -d --wait`) only when it is
  unreachable, so it never recreates a running stack;
- prunes orphans: the databases and Redis keys of worktrees that
  `git worktree list` no longer shows;
- creates this checkout's dev, test and e2e databases if missing, migrates
  all three with this branch's migrations, and provisions the loopback-only
  `offense_demo_e2e` login as a member of the baseline's `offense_demo_web` runtime role
  (ADR 0038);
- writes the slot's `DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_NAMESPACE`,
  `E2E_DATABASE_URL`, `E2E_REDIS_URL`, `E2E_REDIS_NAMESPACE`,
  `TEST_REDIS_URL`, `PORT`, `PUBLIC_APP_URL`, `E2E_PORT` and `REALTIME_PORT`
  into `.env`, keeping host, port and credentials. A worktree's port block is
  claimed on its dev database, so no two checkouts get the same ports; its
  integration suites use Redis database `2 + block`, so their cleanup and
  SCANs never walk another checkout's keys (ADR 0034). The shared
  Redis starts with `--databases 512` for this: if `slot:up` says the server
  offers too few, recreate Redis once with the command it prints (the one
  exception to the rule below, done by an operator, not an agent).

Rules that keep sessions safe:

- Never hand-edit slot values. `bun doctor` fails when `.env` names another
  slot's database or namespace (typically a `.env` copied from the main
  checkout without `bun slot:up`) and warns about orphaned slots.
- `bun slot:down` drops a worktree's databases and Redis keys; run it at
  handoff when no reviewer needs the data. It refuses the main checkout.
  `bun slot:prune` removes every orphaned slot; removing a worktree without
  either leaves its data only until the next `slot:up` anywhere.
- Never stop, recreate or reconfigure the shared stack while other
  checkouts use it; there is deliberately no `infra:down`.
- The browser suite uses four consecutive ports from `E2E_PORT`: the
  production app, its loopback TLS edge (`https://localhost:<E2E_PORT+1>`,
  the configured public origin), the mail capture, and apps/realtime
  (`<E2E_PORT+3>`, ADR 0031). A pinned `E2E_PORT` (or any explicit
  `E2E_DATABASE_URL`/`E2E_REDIS_URL`/`E2E_REDIS_NAMESPACE`) also disables
  Playwright's `reuseExistingServer`, so a session never tests another
  session's already-running server.
- `bun db:reset` accepts only this checkout's own dev and test databases;
  `bun slot:reset-e2e` owns the e2e database, which only the browser suite
  writes, so integration row counts never see e2e rows.
- Generating migrations is still single-writer at a time; see
  `docs/operations/database.md` and `bun migrations:check`.

## Agent identity and guard

Agents started by `pu` run through `scripts/agent-launch.sh`, which exports
the machine identity from the main checkout's `.env.agent` (copy
`.env.agent.example` there; the owner fills in the token). Without
that file the launcher starts agents as the owner with a warning, and
`bun doctor`'s `identity-regime` check warns until it exists. `bun doctor`
reports the identity in `github-identity` and fails an autonomous session
that resolves to the owner; its `checkout` check warns when the main
checkout is on a branch other than `main`, which the committed Claude Code
session-start hook also warns about.

`bun check` and `bun policy` read open PRs through `gh` to catch ADR
numbers claimed twice, so they need the network and an
authenticated `gh`; without either they fail rather than pass.

## Editor

Committed `.vscode/settings.json` (VS Code and Cursor) keeps `.pu/worktrees`,
other checkouts' `node_modules` and build output out of file watching, search
and TypeScript project discovery. Open the main checkout, not the parent of
`.pu/worktrees`, or a window watches every worktree.

## Pre-push hook

`.githooks/pre-push` is committed but inert until you opt in, once per clone:

```sh
bun hooks:install   # git config core.hooksPath .githooks
```

After that every `git push` runs `bun check:affected` against `origin/main` (run `git fetch origin` if the
base is missing) and aborts the push on failure. Agent sessions get the hook
without opting in: `.env.agent` sets `core.hooksPath` for them.

`bun check:affected` inspects the checked-out working tree, so the hook can
only vouch for `HEAD`. It classifies every ref git reports for the push:

| Pushed ref                                                       | Behavior                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| Branch deletion                                                  | Allowed; nothing is sent                             |
| Branch or tag (annotated tags are peeled) whose commit is `HEAD` | Verified; the check runs once per push               |
| Commit already contained in a remote-tracking branch             | Allowed with a notice; nothing new is sent           |
| Any other commit (non-checked-out branch, old unpushed tag)      | Push refused: check that ref out and push from there |

One refused ref refuses the whole push, including multi-ref pushes. The check
covers the working tree, so the hook prints a notice when uncommitted changes
are present; commit or set them aside if you want the result to describe
exactly the pushed commit.

The hook deliberately runs the fast
affected gate (changed-file lint/prettier, boundaries, the repo-wide
duplication gate, affected typecheck/tests), not the full chain: run `bun check` yourself before opening a
PR, and CI remains the enforcement of record. `core.hooksPath` lives in the
repository's shared git config, so it also applies to every worktree of that
clone; each worktree resolves `.githooks` against its own checkout. Undo with
`git config --unset core.hooksPath`; bypass a single push deliberately with
`git push --no-verify`. No hook manager (husky, lefthook) is used or wanted.

## Conventions that save review time

- Root commands are the interface; avoid package-local incantations.
- `bun --env-file=.env run turbo …` is the supported pattern when a turbo
  task needs environment variables: turbo runs in strict env mode and only
  forwards declared variables.
- Never commit `.env`, build outputs, or `.pu/` runtime files.

# Deploy: Fly.io staging

Always-on staging deployment of `apps/web` on Fly.io, org `offense-demo`
.
`fly.toml` (repo root) and `apps/web/Dockerfile` define the app, and
`fly.migrate.toml` the release-only migrator app beside it; this is the
operator runbook for the account-side steps a Builder agent cannot take
(creating billing-adjacent resources, setting secrets, deploying). Every
step's flag names were verified against the installed `flyctl` (v0.4.105,
`flyctl version`) and https://fly.io/docs/reference/configuration/ /
https://fly.io/docs/flyctl/ as of 2026-09-22 — re-check flag names if the
installed flyctl has since changed.

No custom domain: the app is reachable at `https://<app>.fly.dev` only
(owner decision). Postgres is an always-on Fly machine in the same org and
Redis is Fly-native Upstash (owner decision, September 22), both reached
through the `DATABASE_URL` / `MIGRATION_DATABASE_URL` / `REDIS_URL`
contract — no new client libraries.

## Database credentials

Two Fly secrets hold two different PostgreSQL roles, in two different Fly
apps. Fly secrets are app-wide: every secret of an app is an environment
variable on every machine of that app, and on its `release_command`
machine too. Fly has no release-only or per-machine secret. A
`MIGRATION_DATABASE_URL` set on the web app would therefore sit in every
web machine's environment, not only the release command's. So the owner
credential lives in its own release-only app
([ADR 0041](../decisions/0041-migration-credential-in-a-release-only-app.md)):

| Secret                   | App                                                      | Role                                                                                                   | Used by                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL` | `offense-demo-staging-migrate` (`fly.migrate.toml`) only | `offense_demo_migrator`, the schema owner (`fly postgres attach`, superuser, so it holds `CREATEROLE`) | That app's `release_command` (`packages/db/scripts/migrate.ts`), on a temporary machine destroyed when it exits. The runner refuses to run in production without this secret                          |
| `DATABASE_URL`           | `offense-demo-staging` (`fly.toml`)                      | `offense_demo_web`, DML only (created by the baseline migration)                                       | The web app. `start.ts` refuses to start if this role can create or alter anything in schema `public`, and production config refuses to start with `MIGRATION_DATABASE_URL` in the environment at all |

The migrator app has no services and no machines. The workflow deploys it
with `--update-only`, so the only machine that ever holds the owner
credential is the release command's temporary one.

The baseline creates `offense_demo_web` without a password (`CREATE ROLE offense_demo_web
LOGIN` if it is missing). Setting that password is a one-time human step
(step 2). Creating the role with its password before the first deploy is
compatible, because the baseline skips an existing role and grants it the
same privileges.

## Cost (per the owner's spend constraint)

The staging web app is always on. `fly.toml` sets `min_machines_running = 1` and
`auto_stop_machines = "off"`, so its one machine runs continuously and is
billed for every second. Prices were re-read from Fly's live pricing page
on 2026-09-29: shared CPU $0.00000075 per vCPU-second, with 256MB included
per shared vCPU, plus $0.00000193 per GB-second of additional RAM,
multiplied by the region's markup. Chicago (`ord`) carries a 1.25 markup.
A month is 30 days (2,592,000 s), as Fly's own calculator counts it.

| Piece                                                                                       | Monthly cost                                                                                                                                                              | Source                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Web machine `offense-demo-staging` (shared-cpu-1x, 512mb, `ord`), always on                 | (0.00000075 + 0.25 × 0.00000193) × 1.25 ≈ $0.00000154/s ≈ **$3.99/month** (about $4). A running machine's rootfs is not billed separately                                 | https://docs.fly.io/about/pricing/ |
| Migrator app `offense-demo-staging-migrate`                                                 | $0: it has no machines; the release command's temporary machine bills only for the seconds each migration runs                                                            | https://docs.fly.io/about/pricing/ |
| Fly Postgres machine `offense-demo-staging-db` (shared-cpu-1x 256MB, 1GB volume), always on | 0.00000075 × 1.25 × 2,592,000 ≈ $2.43/month compute + $0.15/month volume. Owner decision: left running; `fly machine stop` between sessions drops it to the volume charge | https://docs.fly.io/about/pricing/ |
| Fly Redis `offense-demo-staging-redis` (Upstash, Pay-as-you-go)                             | $0 at rest; $0.20 per 100K commands                                                                                                                                       |                                    |
| Resend                                                                                      | Free tier covers low-volume staging email and webhooks; no cost beyond the account itself                                                                                 | https://resend.com/pricing         |

Net: about $6.57/month at rest: the always-on web machine ($3.99), the
always-on Postgres machine ($2.43) and its volume ($0.15). Staging traffic
adds Redis commands and outbound data transfer on top. The alert
probe (`auth-alerts.yml`) adds nothing: it requests a machine that is
already running.

## Security proof against the live app

`bun scripts/staging-security-probe.ts [--url https://<app>.fly.dev]` proves,
with non-mutating GET/POST-with-bad-origin requests only, that the deployed
app redirects plaintext HTTP to HTTPS, sets no credentialed wildcard CORS,
never shares-caches an account response, refuses a cross-origin state
change (including the `Origin: null` scope) and resolves one real
client identity regardless of a forged `X-Forwarded-For` or `Fly-Client-IP`.
The trusted-client-IP and secret-leak checks additionally read `fly logs`
when this machine has an authenticated flyctl session (`NOT RUN` otherwise).
It never signs in — a real Set-Cookie attribute check needs an actual
session, which is a manual real-device passkey check by the owner; the local proof is
`apps/web/e2e/auth-routes.e2e.ts`'s "a real sign-in sets a host-only,
HttpOnly, Secure, SameSite session cookie" test, over the production
server's HTTPS front.

## Client identity on Fly (verify on every deploy)

`apps/web/src/server/ingress.ts` stamps `x-offense-demo-client-ip` from the raw
socket peer unless that peer is a configured trusted proxy (zero trust: a
forwarded header is only ever read from a peer the deployment names as its
own proxy). Fly's edge (fly-proxy) terminates the client's TLS connection
and reaches the machine over its private IPv4 link — "Fly Proxy reaches
services through a private IPv4 address on each VM, so the process should
listen on `0.0.0.0:<port>`" (https://fly.io/docs/networking/app-services/),
which `apps/web/src/server/start.ts` does. The socket peer is therefore
fly-proxy, not the caller. Once that peer is trusted, `client-ip.ts`
(`resolveClientIp`) reads Fly's own resolved `Fly-Client-IP`
(https://fly.io/docs/networking/request-headers/), falling back to walking
`X-Forwarded-For` from the right only when it is absent or unusable.

**Measured on the reference deployment (2026-09-28):**
reading `/proc/net/tcp` and `/proc/net/tcp6` over `fly ssh console` during
about 40 seconds of public requests showed the app listening on IPv4
`0.0.0.0:8080` only, and every public connection arriving from
`172.19.3.97` — the machine's default gateway (the host end of its
`172.19.3.96/29` link; the machine is `.98`). None arrived over 6PN
(`fdaa::/8`), which the app does not listen on for this port. Two short
connections came from `172.16.3.98`, not the gateway; they are untrusted
and resolve to themselves. Their source is unverified: they are most likely
Fly's own `http_service.checks` against `/api/health/*` (every 15 s), which
would make them harmless, but that is inferred, not measured. If they are
sign-in traffic, those callers share one rate-limit identity. Re-check on
your own deployment after the first deploy.

**Trust boundary: only this machine's default gateway may supply a client IP.** `fly.toml`
sets `AUTH_TRUSTED_PROXIES = "gateway"`. At start, `start.ts` reads
`/proc/net/route` once and `createProductionServer`
(`apps/web/src/server/server-wiring.ts`, through `trusted-proxies.ts`'s
`defaultGateway` and `resolveTrustedProxies`) replaces the keyword with that
single address — derived per machine, so it follows a machine moved to
another host without a config change. No range is trusted: not `fdaa::/8`
(every machine and WireGuard/`fly ssh` peer in the organization shares it),
not the rest of `172.16.0.0/12`, and not Fly's public edge
(`66.241.124.0/22`), which is never the socket peer. When the table has no
default gateway, or more than one, nothing is trusted for the keyword and
the server logs `ingress.trusted_proxy.unresolved` (warn) at start. That
fails closed: every caller then shares the gateway's identity, so
client-keyed rate limits become one staging-wide bucket (the magic-link
rule, `MAGIC_LINK_CLIENT_RULE` in `apps/web/src/features/auth/rate-limit.ts`,
becomes 3 requests per 60 seconds for everyone). Treat that event as an
incident, not noise.

**Who can reach this machine without fly-proxy.** The public internet
cannot reach 6PN, but that is not the boundary. Fly's private networking
docs (https://fly.io/docs/networking/private-networking/, re-read
2026-09-29) state that "Fly Apps in an organization are connected by a
mesh of WireGuard tunnels using IPv6 called a 6PN" and that "6PN addresses
directly connect one Fly Machine with another, bypassing the Fly Proxy".
So any machine of any app in the `offense-demo` org, and any WireGuard
peer (`fly ssh`, `fly proxy`, `fly wireguard`), can open a connection to
this machine's 6PN address that fly-proxy never sees, and can send any
`Fly-Client-IP` or `X-Forwarded-For` it likes. The trust boundary is
therefore the one address `AUTH_TRUSTED_PROXIES = "gateway"` resolves to:
`resolveClientIp` (`apps/web/src/features/auth/client-ip.ts`) reads a
forwarded header only from that peer. A connection that arrives over 6PN
has its own `fdaa:` address as its socket peer, which is not trusted, so it
is keyed by that address and its headers are ignored.
**Measured (2026-09-29, from `offense-demo-staging-db`'s machine over
`fly ssh console`):** this machine's 6PN address answered a TCP connection
on port 22 (hallpass SSH) in 2 ms, so the org's other machines do reach it
directly. Port 8080 on the same address refused the connection: the app
listens on IPv4 `0.0.0.0:8080` only (`/proc/net/tcp`), and nothing but SSH
listens on 6PN (`/proc/net/tcp6`). A request carrying a forged
`Fly-Client-IP` therefore never reached the app over 6PN. If the app ever
listens on IPv6 too, such a request is still keyed by its own `fdaa:` peer,
not by the header.

**Pre-condition: owner sign-off before another app joins the org.** Every
app created in the `offense-demo` org puts its machines on this 6PN. While
this trust configuration stands, no app beyond the three this runbook
creates (`offense-demo-staging`, `offense-demo-staging-migrate` and
`offense-demo-staging-db`) may be created in the org until the owner has
signed off explicitly and that sign-off is recorded: a decision recorded
with `bun decision:record`, confirmed by the owner, and linked from this
section. This is a security-behavior change, so it is the owner's call, not
a Builder's or an operator's. The sign-off must say whether the new app's
machines may reach this one over 6PN, or whether it goes in a custom
private network (`fly apps create --network`) instead.

Confirm the resolved identity after each deploy by comparing, never by
recomputing: the log line's `clientIdHash` is keyed by a subkey of
`BETTER_AUTH_SECRET` (`apps/web/src/features/auth/client-ip.ts`), so it
cannot be reproduced from an address, and the raw address is never
logged (ADR 0019's loggable fields).

```
# /api/health/ready (not /live, which logs nothing) routes through
# handleOperation, whose http.request.completed log carries clientIdHash.
# Send one request from this machine and one from a different network
# (a phone hotspot, a cloud shell):
curl -s https://<app>.fly.dev/api/health/ready
fly logs -a <app> --no-tail | grep '"event":"http.request.completed"'
```

Two callers on different networks must produce two different
`clientIdHash` values, and repeat requests from one caller the same value.
If every request carries the same hash, whichever network it came from,
the ingress is resolving fly-proxy's own address rather than the caller.

Then prove a caller cannot choose its own identity. From one machine, send
two requests with different forged `X-Forwarded-For` values, and two more
with different forged `Fly-Client-IP` values:

```
curl -s https://<app>.fly.dev/api/health/ready -H "X-Forwarded-For: 203.0.113.9"
curl -s https://<app>.fly.dev/api/health/ready -H "X-Forwarded-For: 198.51.100.7"
curl -s https://<app>.fly.dev/api/health/ready -H "Fly-Client-IP: 203.0.113.9"
curl -s https://<app>.fly.dev/api/health/ready -H "Fly-Client-IP: 198.51.100.7"
fly logs -a <app> --no-tail | grep '"event":"http.request.completed"'
```

All four lines must carry the same `clientIdHash`, which is also the value
this machine logs with no forged header at all: fly-proxy overwrites both
headers with its own resolved value before the app ever sees the request,
so a caller-supplied `Fly-Client-IP` or `X-Forwarded-For` never reaches
`client-ip.ts`. A different hash on any of the four means the ingress
trusted a caller-supplied hop, so a caller could pick its rate-limit
identity.

If every caller resolves to one hash, first check the start-up log for
`ingress.trusted_proxy.unresolved`, then re-measure the peer address as
above before changing `AUTH_TRUSTED_PROXIES`; never widen it to a range to
make the symptom go away.

Better Auth trusts only `x-offense-demo-client-ip` (`CLIENT_IP_HEADER`), stamped by
the ingress above — there is no deployment-configurable header list to set
here.

## Always-on behavior

- **The machine keeps running.** `auto_stop_machines = "off"` means
  fly-proxy never stops it for idleness, and `min_machines_running = 1`
  keeps one machine in the region. It stops only for a deploy, a
  `fly machine restart`, a host event or a crash. `auto_start_machines =
true` starts it again on the next request if it is ever found stopped.
  Check it at any time with `fly status -a offense-demo-staging`: the one
  `app` machine is `started`, with 2 of 2 checks passing.
- **The hourly retention sweep runs continuously.**
  `apps/web/src/server/start.ts` starts `startRetentionSweep` (hourly
  `setInterval`, `runOnStart: true`) in-process, so expired verification,
  session, outbox and email rows and lapsed online-presence members are
  pruned every hour, and once more right after every deploy or restart.
- **Start-up and health checks.** `start.ts` opens port 8080
  before its slow start-up work (the runtime-role check and Next's
  `prepare()`), behind `createStartupGate`
  (`apps/web/src/server/listen-first.ts`). Until that work finishes,
  `/api/health/live` answers `200` and every other path, `/api/health/ready`
  included, answers `503` without reaching Next, so fly-proxy routes no
  traffic to a machine that is still preparing. The process then logs
  `server.ready` with `durationMs`, the time from listening to ready.
  **Measured on the reference deployment (2026-09-29):** 13 boots, 9 by `fly machine stop` then
  `fly machine start` and 4 by `fly deploy` (the last, boot 13, is the
  deploy that applied the 15s grace period). Every offset is from the
  boot's anchor, its first platform log line ("Starting machine", or
  "Configuring firecracker" for a deploy), to the `server.start` and
  `server.ready` log lines' `time` and Fly's "Health check ... is now
  passing" lines, all read from `fly logs -a offense-demo-staging -j`.

  | #   | Kind       | Anchor (UTC)             | server.start | server.ready | Liveness passing | Readiness passing | server.ready durationMs |
  | --- | ---------- | ------------------------ | ------------ | ------------ | ---------------- | ----------------- | ----------------------- |
  | 1   | stop/start | 2026-09-29T16:33:59.724Z | 3.43s        | 6.11s        | 3.53s            | 7.76s             | 2680                    |
  | 2   | stop/start | 2026-09-29T16:34:33.950Z | 3.38s        | 6.03s        | 4.91s            | 7.92s             | 2655                    |
  | 3   | stop/start | 2026-09-29T16:35:04.945Z | 3.43s        | 6.08s        | 3.48s            | 7.70s             | 2655                    |
  | 4   | stop/start | 2026-09-29T16:36:24.862Z | 3.56s        | 6.15s        | 3.79s            | 8.01s             | 2594                    |
  | 5   | stop/start | 2026-09-29T16:36:59.131Z | 3.42s        | 6.10s        | 3.91s            | 7.53s             | 2672                    |
  | 6   | stop/start | 2026-09-29T16:37:32.408Z | 3.41s        | 6.08s        | 3.82s            | 7.43s             | 2663                    |
  | 7   | stop/start | 2026-09-29T16:38:06.554Z | 3.44s        | 6.09s        | 4.06s            | 7.68s             | 2648                    |
  | 8   | stop/start | 2026-09-29T16:38:38.477Z | 3.40s        | 6.06s        | 4.71s            | 7.74s             | 2660                    |
  | 9   | stop/start | 2026-09-29T16:39:42.763Z | 3.47s        | 6.03s        | 5.00s            | 7.41s             | 2561                    |
  | 10  | deploy     | 2026-09-29T16:41:53.141Z | 5.01s        | 7.62s        | 5.59s            | 9.21s             | 2615                    |
  | 11  | deploy     | 2026-09-29T16:42:42.490Z | 4.43s        | 7.08s        | 4.49s            | 8.72s             | 2646                    |
  | 12  | deploy     | 2026-09-29T16:43:31.306Z | 4.39s        | 7.08s        | 5.14s            | 8.76s             | 2695                    |
  | 13  | deploy     | 2026-09-29T16:45:20.625Z | 4.98s        | 7.66s        | 6.27s            | 9.28s             | 2687                    |

  | Phase                                       | min   | median | max   | p95 (nearest rank) |
  | ------------------------------------------- | ----- | ------ | ----- | ------------------ |
  | Port open (`server.start`)                  | 3.38s | 3.44s  | 5.01s | 5.01s              |
  | Start-up work (`server.ready` `durationMs`) | 2.56s | 2.66s  | 2.70s | 2.70s              |
  | `server.ready`                              | 6.03s | 6.10s  | 7.66s | 7.66s              |
  | Liveness check passing (`servicecheck-00`)  | 3.48s | 4.49s  | 6.27s | 6.27s              |
  | Readiness check passing (`servicecheck-01`) | 7.41s | 7.76s  | 9.28s | 9.28s              |

  Nearest-rank p95 of 13 is the 13th smallest value (⌈0.95 × 13⌉ = 13).
  Readiness passing, sorted: 7.41, 7.43, 7.53, 7.68, 7.70, 7.74, 7.76,
  7.92, 8.01, 8.72, 8.76, 9.21, 9.28 s, so p95 is 9.28s. Under a 10s grace
  period that leaves 0.72s, less than the 2s margin this deployment
  requires, so `fly.toml` sets the readiness check's `grace_period` to
  15s: a 5.72s margin. (The first 12 boots alone give p95 9.21s, rank 12
  of 12, and a 5.79s margin.) Liveness passes by 6.27s at p95 and keeps
  10s (3.73s margin). The deploys are the slow end: the new VM boots while
  the old process drains. Re-measure after any change to start-up work:
  stream `fly logs -a offense-demo-staging -j` to a file, run
  `fly machine stop <id>`, `fly machine wait <id> --state stopped` and
  `fly machine start <id>` several times, and read the "Starting machine",
  `server.start`, `server.ready` and "Health check ... is now passing"
  lines.

- **Resend webhook delivery.** Resend's webhooks are Svix-powered and retry
  non-2xx or unreachable deliveries 5 seconds, 5 minutes, 30 minutes, 2
  hours, 5 hours and 10 hours after the original attempt
  (https://resend.com/docs/dashboard/webhooks/introduction), roughly an
  18-hour window. A delivery normally reaches the running machine on its
  first attempt; one that lands during a deploy or restart gets `503` from
  the start-up gate and is retried inside that window.
- **Passkey RP hostname stability.** `apps/web/src/features/auth/server.ts`
  derives the WebAuthn RP ID as `new URL(config.PUBLIC_APP_URL).hostname`.
  `PUBLIC_APP_URL` is fixed at `https://<app>.fly.dev` (no custom domain),
  and that hostname never changes across deploys or restarts; only the
  underlying machine and its 6PN address can change, and RP ID depends on
  neither. Passkeys registered against this staging app stay valid.

## Turning staging on

The deploy workflow and the scheduled auth alert probe stay off (they skip
without taking a runner) until the repository variable `STAGING_ENABLED` is
`true`. Set it once the steps below have created and configured the apps:

```
gh variable set STAGING_ENABLED --body true
```

## 1. Create the app

```
fly auth login                       # once per operator machine
fly apps create offense-demo-staging --org offense-demo
fly apps create offense-demo-staging-migrate --org offense-demo   # release-only migrator (ADR 0041)
```

Verify: `fly status -a offense-demo-staging` and
`fly status -a offense-demo-staging-migrate` show both apps with no machines
yet (this only reserves the names; the `app` fields of `fly.toml` and
`fly.migrate.toml` must match).

These two apps and step 2's Postgres app are the only apps this org may
hold without the owner's recorded sign-off; see "Pre-condition: owner
sign-off before another app joins the org" under "Client identity on Fly".

## 2. Provision Postgres

Owner decision (September 22): staging Postgres is an ordinary Fly machine
in the same org, left running (about $2.43/month for shared-cpu-1x 256MB in
`ord` plus $0.15/GB volume, see "Cost"), not an external provider. It is a single unmanaged
machine: no automatic backups or failover — fine for staging only.

```
fly postgres create --name offense-demo-staging-db --org offense-demo --region ord \
  --vm-size shared-cpu-1x --volume-size 1 --initial-cluster-size 1
# The migration owner, attached to the migrator app only. Attach creates a
# superuser login, prints its URL and sets it as that app's secret.
fly postgres attach offense-demo-staging-db -a offense-demo-staging-migrate \
  --database-name offense_demo_staging --database-user offense_demo_migrator \
  --variable-name MIGRATION_DATABASE_URL

# The runtime role, once: a random password, then the role holding it.
OFFENSE_DEMO_WEB_PASSWORD="$(bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))')"
echo "CREATE ROLE offense_demo_web LOGIN PASSWORD '$OFFENSE_DEMO_WEB_PASSWORD';" \
  | fly postgres connect -a offense-demo-staging-db -d offense_demo_staging
# Same host, port, database and query string as the URL attach printed;
# only the user and password differ.
fly secrets import -a offense-demo-staging --stage <<SECRETS
DATABASE_URL=postgres://offense_demo_web:$OFFENSE_DEMO_WEB_PASSWORD@<host:port from attach>/offense_demo_staging?sslmode=disable
SECRETS
unset OFFENSE_DEMO_WEB_PASSWORD
```

If `offense_demo_web` already exists (a deploy has run), use `ALTER ROLE offense_demo_web
PASSWORD '...'` instead of `CREATE ROLE`.

Verify: `fly secrets list -a offense-demo-staging-migrate` shows only
`MIGRATION_DATABASE_URL`, and `fly secrets list -a offense-demo-staging`
shows `DATABASE_URL` and no `MIGRATION_DATABASE_URL`.

## 3. Provision Redis

Upstash is native on Fly; the pay-as-you-go plan is free at staging volumes
($0.20 per 100K commands). The ProdPack prompt must be declined explicitly
when flyctl runs without a TTY:

```
fly redis create --org offense-demo --region ord --name offense-demo-staging-redis \
  --no-replicas --disable-eviction --plan "Pay-as-you-go" --enable-prodpack=false
fly redis status offense-demo-staging-redis      # shows the private redis:// URL
fly secrets import -a offense-demo-staging --stage <<SECRETS
REDIS_URL=<that url>
SECRETS
```

Verify: `fly secrets list -a offense-demo-staging` shows `REDIS_URL` (staged).

## 4. Create the Resend webhook (before first deploy)

Before setting `AUTH_EMAIL_FROM` (step 5), choose a sending path:

- **Normal staging delivery**: add and verify a sending domain in the Resend
  dashboard, then use a sender address from that domain (for example
  `Offense Demo <no-reply@yourdomain.example>`). Once verified, that domain can send
  to any recipient.
- **Account-only smoke test**: use the built-in `onboarding@resend.dev`
  sender with no domain setup. Resend restricts this sender to delivering
  only to the email address registered on the Resend account
  (https://resend.com/docs/knowledge-base/403-error-resend-dev-domain) — any
  other recipient gets a 403. Step 7's sign-in check must target that same
  account email when this path is chosen.

The signing secret only exists once the webhook is created, and production
refuses to boot without `RESEND_WEBHOOK_SECRET` — create the webhook first,
even though the app is not live yet; Resend will queue/retry failed
deliveries per the schedule above once the app exists.

1. In the Resend dashboard, create a webhook targeting
   `https://offense-demo-staging.fly.dev/api/webhooks/resend`.
2. Subscribe to: `email.sent`, `delivery_delayed`, `delivered`, `failed`,
   `bounced`, `complained`.
3. Copy the signing secret (`whsec_...`).

Verify: the Resend dashboard shows the webhook as created with those six
events checked (delivery will show as failing until step 7 — that's
expected, nothing is listening yet).

## 5. Set secrets

Rotating one of these later (routine or emergency) follows
[secret-rotation-rehearsal.md](secret-rotation-rehearsal.md),
including the safe `fly secrets import` pattern that never takes a secret
value as a CLI argument, and, for `OPS_PROBE_TOKEN`, the matching GitHub
repository secret it must always agree with.

`OPS_PROBE_TOKEN` also needs setting as a GitHub repository secret for the
scheduled `auth-alerts.yml` workflow (below), so it is generated into a
shell variable first, imported to Fly, then piped to `gh` from that same
variable — never displayed, never a command-line argument, never typed
twice:

```
# DATABASE_URL was set in step 2 and REDIS_URL staged in step 3; do not set
# them again here. MIGRATION_DATABASE_URL belongs to the migrator app only.
better_auth_secret="$(bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),""))')"
recipient_hash_secret="$(bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),""))')"
ops_probe_token="$(bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),""))')"
fly secrets import -a offense-demo-staging --stage <<SECRETS
BETTER_AUTH_SECRET=$better_auth_secret
RECIPIENT_HASH_SECRET=$recipient_hash_secret
RESEND_API_KEY=re_...
AUTH_EMAIL_FROM=Offense Demo <no-reply@yourdomain.example>
RESEND_WEBHOOK_SECRET=whsec_...
OPS_PROBE_TOKEN=$ops_probe_token
SECRETS
echo -n "$ops_probe_token" | gh secret set OPS_PROBE_TOKEN
unset better_auth_secret recipient_hash_secret ops_probe_token
```

`RECIPIENT_HASH_SECRET` is a distinct value from `BETTER_AUTH_SECRET`
(ADR 0044), never the same value copied twice: it keys the
suppression ledger and per-recipient rate-limit buckets independently of
the session-signing secret, so routinely rotating `BETTER_AUTH_SECRET`
never desynchronizes them.

`APP_VERSION` and `GIT_COMMIT` are non-secret and set per-release, not as
persistent secrets — pass them as build args or set them via
`fly deploy --env` at deploy time (step 6); production refuses to boot with
`APP_VERSION`/`GIT_COMMIT` at their `development`/`unknown` defaults
(`packages/config/src/index.ts`).

Verify: `fly secrets list -a offense-demo-staging` shows all eight names
(not values — Fly never displays a set secret's value back), and no
`MIGRATION_DATABASE_URL`; `gh secret list` shows `OPS_PROBE_TOKEN` with a
recent "Updated" timestamp. Rotating `OPS_PROBE_TOKEN` later — planned or
emergency — is documented in
[secret-rotation-rehearsal.md](secret-rotation-rehearsal.md#ops_probe_token),
never repeated here.

Verify: the next scheduled (or manually dispatched) `auth-alerts.yml` run
succeeds against `/api/ops/alerts` — a stale GitHub-side value fails that
step with 401, distinguishing "both rotated" from "only Fly rotated."

## 6. First deploy

Run from the repository root (so `apps/web/Dockerfile`'s build context is
the monorepo):

```
# 1. Migrate: the migrator app's release command, no machines created.
fly deploy -c fly.migrate.toml --remote-only --update-only \
  --build-arg APP_VERSION="$(git rev-parse --short HEAD)" \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)"
# 2. Only after step 1 succeeds: the web app.
fly deploy -a offense-demo-staging --ha=false \
  --build-arg APP_VERSION="$(git rev-parse --short HEAD)" \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)"
```

`fly.migrate.toml`'s `[deploy] release_command = "bun /app/packages/db/scripts/migrate.ts"`
runs once as `MIGRATION_DATABASE_URL`, before the web release. Its session
gives up on a lock after 1 s, so a migration blocked by live
traffic fails step 1 and step 2 never runs. Do not add a migration step
anywhere else, and never add a `release_command` to `fly.toml`. The web app
starts as `DATABASE_URL` (`offense_demo_web`). A release still pointing
`DATABASE_URL` at the owner fails startup with "Production refuses a
DATABASE_URL role that …". A web app that still holds
`MIGRATION_DATABASE_URL` fails startup with "Invalid server configuration:
MIGRATION_DATABASE_URL".

Verify: `fly releases -a offense-demo-staging-migrate` shows the release as
successful and `fly machines list -a offense-demo-staging-migrate` lists no
machines. `fly status -a offense-demo-staging` shows one deployed release
and `fly releases -a offense-demo-staging` shows it as successful.

`--ha=false` keeps one machine: without it `fly deploy` creates two for
high availability, which doubles the (idle-free) footprint and is
pointless for staging. If two exist, `fly scale count 1 -a offense-demo-staging`.

## 7. Verify

```
# Health
curl -sS https://offense-demo-staging.fly.dev/api/health/live
curl -sS https://offense-demo-staging.fly.dev/api/health/ready

# Sign-in email delivered: start a magic-link sign-in against the running
# app, then confirm Resend's dashboard shows the message as sent/delivered
# for that recipient. If AUTH_EMAIL_FROM uses onboarding@resend.dev (step 4
# account-only path), this MUST be the Resend account's own email address —
# any other recipient gets a 403 and the email never sends. Otherwise use
# any real inbox you control under the verified sending domain.
curl -sS -X POST https://offense-demo-staging.fly.dev/api/auth/sign-in/magic-link \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://offense-demo-staging.fly.dev' \
  -d '{"email":"you@yourdomain.example"}'

# Webhook event received: after the email above is delivered, check
# structured logs for an applied delivery event.
fly logs -a offense-demo-staging --no-tail | grep -i 'mail.webhook\|delivery'
```

All three must show success before calling staging ready. Also re-run the
client-identity check from "Client identity on Fly" above.

## 8. Rollback

flyctl v0.4.105 has no dedicated rollback subcommand; redeploy a prior
release's image explicitly:

```
fly releases -a offense-demo-staging --image     # find the prior release's image ref
fly deploy -a offense-demo-staging --image <prior-image-ref>
```

Rolling back the web image never rolls back the schema: migrations are
forward-only and expand/contract, so the previous release still runs
against the newer schema. Do not redeploy the migrator app to roll back.

Verify: `fly releases -a offense-demo-staging` shows the rollback as the
newest release, and step 7's health checks pass again.

## 9. Destroy

```
fly apps destroy offense-demo-staging --yes
fly apps destroy offense-demo-staging-migrate --yes
fly apps destroy offense-demo-staging-db --yes      # the Postgres machine and its volume (the recurring charge)
fly redis destroy offense-demo-staging-redis --yes
```

Then delete the Resend webhook (`resend webhooks delete <id>`) and rotate
`FLY_API_TOKEN` and `FLY_MIGRATE_API_TOKEN` out of the GitHub repository
secrets (`fly tokens revoke`, `gh secret delete FLY_API_TOKEN`,
`gh secret delete FLY_MIGRATE_API_TOKEN`).

Verify: `fly status -a offense-demo-staging`,
`fly status -a offense-demo-staging-migrate` and
`fly status -a offense-demo-staging-db` all return "app not found", and
`fly redis list` no longer lists the database.

## 10. Continuous deployment (GitHub Actions)

`.github/workflows/deploy-staging.yml` deploys a `main` push once its CI
gate job and its Browser E2E run are both green, checked out at the
verified `head_sha`, or on manual `workflow_dispatch`. Both workflows
trigger it on completion; `scripts/staging-gate.ts` reads the two runs for
the commit and lets only the later completion deploy, so each commit ships
once, and only while it is still `main`'s tip: re-running an older commit's
CI or E2E never rolls staging back. The CI gate needs the dependency audit
job (ADR 0039), so a new advisory holds staging back and posts to
Incidents. The deploy job's `migrate` step deploys the migrator app
(`fly.migrate.toml`, `--update-only`) and its `deploy` step, which runs
only after `migrate` succeeds, deploys the web app. The workflow needs two
repository secrets, each a deploy token scoped to one app and exposed only
on its own step:

```
fly tokens create deploy -a offense-demo-staging --name github-actions-staging --expiry 8760h \
  | gh secret set FLY_API_TOKEN
fly tokens create deploy -a offense-demo-staging-migrate --name github-actions-staging-migrate --expiry 8760h \
  | gh secret set FLY_MIGRATE_API_TOKEN
```

Each token can deploy only its own app; rotate one by re-running its
command. Production is never deployed by this workflow (production deploys
are human-gated). Verify: the "Deploy staging" run is green after a main merge
and `/api/health/ready` answers at the staging hostname.

A failed deploy posts to the drive's Incidents channel, the same way
`ci.yml` reports CI failures. The workflow's `notify-drive` job runs when
the gate job or the deploy job fails and calls `scripts/notify-drive.ts
incidents --deploy offense-demo-staging`. The message names the app, the
first failing step (`<job>.<step id>`, for example `deploy.readiness`), the
commit and the run URL. It never carries flyctl output, secrets or
database URLs. The job holds only the Incidents webhook URL and secret
(`PAGESPACE_INCIDENTS_WEBHOOK_URL`, `PAGESPACE_INCIDENTS_WEBHOOK_SECRET`,
the repository secrets `ci.yml` already uses), scoped to the step that
posts.

The separate `auth-alerts.yml` workflow needs `OPS_PROBE_TOKEN`
as a repository secret (the exact value set on the app above via `fly
secrets import`, step 5) alongside the same two Incidents webhook secrets;
see [auth-delivery.md](auth-delivery.md#alerting).

## Staging data inventory

Staging holds no third-party data. Before calling a staging reset or a
restore rehearsal done, read `users`, `session`, `passkey` and
`verification` row by row and attribute every row: synthetic seed users
from `scripts/staging-restore-seed.ts` (RFC 2606 `@example.test`
addresses, never delivered) need no action; owner-operated verification
accounts are `personal`/`private` data with the staging environment's
lifecycle as their retention; a session whose cookie was ever exposed (for
example pasted into a chat during a cookie check) is deleted directly. Any
row carrying more than an email address and standard auth credential
material is an incident.

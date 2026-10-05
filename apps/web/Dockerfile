# Production image for apps/web (AUTH-7.0). Multi-stage: a full workspace
# install builds the Next.js production bundle, then a separate
# production-only install keeps the runtime image lean. Workspace packages
# (packages/*) export raw TypeScript from ./src (see each package.json
# "exports"): Bun transpiles them at run time, so there is no package build
# step to run before `next build` — only the source tree needs to be present.
#
# Base image: oven/bun:1.4.2-slim, pinned to the exact version in
# .bun-version (glibc/Debian, not -alpine): Next.js ships glibc-linked
# @next/swc native binaries, and Debian-slim avoids musl compatibility risk
# for a marginal size difference. scripts/verify-deploy-config.test.ts fails
# if this tag drifts from .bun-version.
FROM oven/bun:1.4.2-slim AS base
WORKDIR /app

# ---- deps: full workspace install (dev + prod) needed to run `next build`
# (tailwindcss/postcss run at build time; typecheck is not run in this
# image, `bun check` covers it in CI).
FROM base AS deps
COPY package.json bun.lock .bun-version ./
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/clock/package.json packages/clock/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/errors/package.json packages/errors/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/redis/package.json packages/redis/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN bun install --frozen-lockfile

# ---- build: full source + `next build` (production bundle only; the app is
# started by src/server/start.ts, never `next start`).
FROM deps AS build
COPY . .
# `.next/cache` is Turbopack's build-time incremental cache (~130MB here):
# useful for rebuild speed, unneeded and never read at runtime, dropped
# before the runtime stage copies from this layer so it never ships.
RUN NODE_ENV=production bun run --cwd apps/web build \
  && rm -rf apps/web/.next/cache

# ---- prod-deps: a second, production-only install for the runtime image.
# Workspace packages have no separate "dist": their ./src TypeScript ships
# as-is, so this stage still needs the full source tree, just not
# devDependencies (eslint, jscpd, playwright, typescript, ...).
FROM base AS prod-deps
COPY package.json bun.lock .bun-version ./
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/clock/package.json packages/clock/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/errors/package.json packages/errors/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/redis/package.json packages/redis/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN bun install --frozen-lockfile --production

# ---- runtime: non-root, only what start.ts and the built Next app need.
FROM base AS runtime
# Deployment identity: production refuses to boot at the `development`/
# `unknown` defaults (packages/config/src/index.ts). Passed with
# `fly deploy --build-arg APP_VERSION=... --build-arg GIT_COMMIT=...`
# (see docs/operations/deploy-staging.md step 6); baked in as ENV so they
# are present in the running container, not just at build time.
ARG APP_VERSION=development
ARG GIT_COMMIT=unknown
ENV APP_VERSION=${APP_VERSION}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV NODE_ENV=production
# Fly's http_service.internal_port; start.ts reads PORT and binds 0.0.0.0.
ENV PORT=8080
RUN groupadd --system --gid 1001 offense-demo \
  && useradd --system --uid 1001 --gid offense-demo --home-dir /app --shell /usr/sbin/nologin offense-demo
# Bun's isolated linker gives every workspace its own node_modules (symlinks
# into a shared /app/node_modules/.bun store), not just a root node_modules:
# copy the whole prod-deps tree rather than cherry-picking node_modules
# directories, then overlay source and build output on top of it.
COPY --from=prod-deps --chown=offense-demo:offense-demo /app /app
COPY --chown=offense-demo:offense-demo apps/web/src apps/web/src
COPY --chown=offense-demo:offense-demo apps/web/public apps/web/public
COPY --chown=offense-demo:offense-demo apps/web/next.config.ts apps/web/next.config.ts
COPY --chown=offense-demo:offense-demo apps/web/postcss.config.mjs apps/web/postcss.config.mjs
COPY --from=build --chown=offense-demo:offense-demo /app/apps/web/.next apps/web/.next
COPY --chown=offense-demo:offense-demo packages/auth/src packages/auth/src
COPY --chown=offense-demo:offense-demo packages/clock/src packages/clock/src
COPY --chown=offense-demo:offense-demo packages/config/src packages/config/src
COPY --chown=offense-demo:offense-demo packages/db/src packages/db/src
# fly.toml's release_command runs the migration runner directly out of this
# image (see packages/db/scripts/migrate.ts); it and the migrations it
# applies are not otherwise reachable from the runtime stage.
COPY --chown=offense-demo:offense-demo packages/db/scripts packages/db/scripts
COPY --chown=offense-demo:offense-demo packages/db/migrations packages/db/migrations
COPY --chown=offense-demo:offense-demo packages/errors/src packages/errors/src
COPY --chown=offense-demo:offense-demo packages/logger/src packages/logger/src
COPY --chown=offense-demo:offense-demo packages/observability/src packages/observability/src
COPY --chown=offense-demo:offense-demo packages/protocol/src packages/protocol/src
COPY --chown=offense-demo:offense-demo packages/redis/src packages/redis/src
USER offense-demo
WORKDIR /app/apps/web
EXPOSE 8080
CMD ["bun", "src/server/start.ts"]

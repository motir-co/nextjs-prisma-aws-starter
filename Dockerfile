# syntax=docker/dockerfile:1.7
#
# The ONE image this starter runs as (MOTIR-9810 · MOTIR-9812; the hosting
# record's D-3 and §4): on Lambda in the stack's functions mode, on ECS Fargate
# in its containers mode, and as the migration task in both (infra/). Values
# below are the ones motir.hosting.json declares — tests/hosting-manifest.test.ts
# holds the two files to each other.
#
#   build:   docker buildx build --platform linux/amd64 -t app .
#   run:     docker run -p 3000:3000 -e BETTER_AUTH_SECRET=… -e DATABASE_URL=… app
#   migrate: docker run --rm -e DATABASE_URL=… app \
#              node migrate/node_modules/prisma/build/index.js migrate deploy --config migrate/prisma.config.ts
#
# The build needs no database: `next build` never migrates (that is the
# manifest's `database.migrateCommand`, run from this same image), and the
# placeholders in the build stage only let modules that read their variables at
# load time be imported. None of them reaches the runtime stage.

ARG NODE_VERSION=22

FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ── Dependencies (cached on the lockfile) ───────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ── The manifest's buildCommand ─────────────────────────────────────────────
FROM deps AS build
ARG MOTIR_BUILD_COMMAND="pnpm build"
COPY . .
RUN BETTER_AUTH_SECRET=image-build-placeholder-not-a-secret-32-bytes \
    DATABASE_URL=postgresql://build:build@127.0.0.1:1/build \
    sh -c "$MOTIR_BUILD_COMMAND"

# ── The Prisma CLI for database.migrateCommand, at the versions the lockfile pins
FROM deps AS migrate
RUN mkdir /migrate && cd /migrate && echo '{"private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
      "prisma@$(node -p "require('/app/node_modules/prisma/package.json').version")" \
      "dotenv@$(node -p "require('/app/node_modules/dotenv/package.json').version")"
COPY prisma.config.ts /migrate/prisma.config.ts
COPY prisma /migrate/prisma

# ── The entrypoint that loads the stack's secrets (scripts/aws/entrypoint.mjs) ─
# Its one dependency, the Secrets Manager client, at the version the lockfile
# pins; and Amazon RDS's CA bundle, which node-postgres needs to verify the
# database's certificate (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).
FROM deps AS aws
RUN mkdir /aws && cd /aws && echo '{"private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
      "@aws-sdk/client-secrets-manager@$(node -p "require('/app/node_modules/@aws-sdk/client-secrets-manager/package.json').version")"
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /aws/rds-global-bundle.pem
COPY scripts/aws/entrypoint.mjs scripts/aws/environment.mjs /aws/

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    AWS_LWA_PORT=3000 \
    AWS_LWA_READINESS_CHECK_PATH=/api/health \
    AWS_LWA_INVOKE_MODE=response_stream
WORKDIR /app

# The Lambda Web Adapter (record §3): on Lambda it turns invocations into HTTP
# requests against PORT; everywhere else (Fly, ECS, a laptop) it is inert.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=migrate --chown=node:node /migrate ./migrate
COPY --from=aws --chown=node:node /aws ./aws

USER node
EXPOSE 3000
# Off AWS no secret ARN is set and the entrypoint just runs the command.
ENTRYPOINT ["node", "aws/entrypoint.mjs"]
CMD ["node", "server.js"]

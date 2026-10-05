# syntax=docker/dockerfile:1.7

# ---------- base ----------
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
WORKDIR /app
RUN apk add --no-cache libc6-compat

# ---------- deps ----------
# Installed in their own layer so a source-only change does not reinstall the tree.
FROM base AS deps
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, `npm install` on the very first build.
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------- dev ----------
FROM deps AS dev
COPY . .
ENV NODE_ENV=development
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ---------- build ----------
FROM deps AS build
COPY . .
# `prisma generate` never opens a connection, but the config resolves DATABASE_URL
# eagerly, so a placeholder keeps the build independent of runtime configuration.
# The real value is injected by compose and is what `migrate deploy` uses.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    npm run db:generate && npm run build

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    UPLOAD_TMP_DIR=/tmp/discorddrive
WORKDIR /app

# Prisma's compiled client and our output are the only runtime artifacts needed by
# the server. `src/` and `prisma7.config.ts` come along because `npm run db:seed`
# runs through tsx against the generated client, which Prisma 7 emits as TypeScript.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY prisma ./prisma
COPY prisma7.config.ts ./prisma7.config.ts

# The Prisma CLI is needed at boot to run `migrate deploy` before the server starts.
RUN apk add --no-cache openssl \
    && mkdir -p /tmp/discorddrive \
    && chown -R node:node /app /tmp/discorddrive

USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are applied before the server starts, so a fresh `docker compose up`
# against an empty volume comes up with a usable schema.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

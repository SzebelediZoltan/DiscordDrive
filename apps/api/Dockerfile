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
# `npm run db:generate &&` joins this RUN in issue #2, once prisma/schema.prisma exists.
RUN npm run build

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    UPLOAD_TMP_DIR=/tmp/discorddrive
WORKDIR /app

# Prisma's generated client and the compiled output are the only runtime artifacts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY prisma ./prisma

# The Prisma CLI is needed at boot to run `migrate deploy` before the server starts.
RUN apk add --no-cache openssl \
    && mkdir -p /tmp/discorddrive \
    && chown -R node:node /app /tmp/discorddrive

USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `npx prisma migrate deploy &&` is prepended to this command in issue #2, once
# the schema and migrations exist.
CMD ["node", "dist/server.js"]

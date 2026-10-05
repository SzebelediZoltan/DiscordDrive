# DiscordDrive

Turn any Discord webhook into unlimited file storage. Files of any size, including
multi-gigabyte ones, are split into chunks, dispatched to Discord as attachments, and
reassembled on demand.

> **Status:** scaffold. Feature modules land in issues
> [#2](https://github.com/SzebelediZoltan/DiscordDrive/issues/2)&ndash;[#16](https://github.com/SzebelediZoltan/DiscordDrive/issues/16).

## Quickstart

```bash
./scripts/setup-env.sh   # generates .env with random secrets (idempotent)
docker compose up --build
```

The UI is then on <http://localhost:8080>.

For hot module reloading instead of a production build:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

## Services

| Service | Role | Published |
|---|---|---|
| `db` | PostgreSQL 17, file storage volume, healthchecked, **not** exposed to the host | internal `5432` |
| `api` | Express 5 + Prisma 7, runs `migrate deploy` then serves on `:4000` | internal |
| `web` | nginx serving the built SPA and proxying `/api` to `api:4000` | `8080` |

The API is deliberately not published in the production compose file. The SPA and the
API share one origin through nginx, which is what lets the session cookie stay
`httpOnly` + `SameSite=Lax` with no CORS configuration. The dev override publishes it
on `4000` for curl and tests.

## Layout

```
apps/api     Express 5, Prisma 7, TypeScript (ESM)
apps/web     Vite 8, React 19, Tailwind v4
scripts      Environment generation, smoke tests
```

## Known limitations

Stated up front rather than discovered later:

- **Discord is not a file host.** This is a grey area under Discord's Terms of Service.
  Use it with content you are willing to have deleted.
- **Attachment URLs expire.** Discord signs every `cdn.discordapp.com` URL with an
  expiry. Adding a bot token per user lets DiscordDrive mint fresh URLs on demand;
  without one, expired files must be re-uploaded.
- **Chunk size ceiling.** Webhook attachments are capped well below Discord's
  documented user upload limit, so DiscordDrive measures the real limit per webhook
  instead of assuming one.

## Licence

Private. All rights reserved.

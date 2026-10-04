# Self-hosting with Docker

Commands run from the repository root. `C` stands for `docker compose -f docker/compose.yaml`.

## Install

1. `cp docker/.env.example docker/.env` and set `POSTGRES_PASSWORD`.
2. `C up -d --build`

`migrate` runs once and exits. `server` and `worker` start after it succeeds. The app listens on `HTTP_PORT` (default 8080). `GET /healthz` returns `200` with `{"status":"ok"}` when the database and job queue are reachable.

## Configuration

`docker/.env`:

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | — | Database credentials; also used to build `DATABASE_URL` |
| `HTTP_PORT` | `8080` | Host port for the server |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `BACKUP_RETENTION_DAYS` | `14` | Days of nightly dumps kept by the `backup` service |
| `RSS_READER_IMAGE` | `rss-reader:latest` | Image tag to build or run |

Application variables, set in `compose.yaml`:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection URL |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | Server bind address inside the container |
| `BLOB_DIR` | `/data/blobs` | Favicon and image cache (`blobs` volume) |

## Upgrade

`git pull && C up -d --build`. Migrations apply before the new server and worker start.

## Reverse proxy and TLS

Put a TLS-terminating proxy in front of the server. `docker/caddy/Caddyfile` is a working Caddy example. Any proxy must not buffer responses on `/api/v1/events` (server-sent events): for nginx, set `proxy_buffering off` on that location.

## Backups

- Enable nightly dumps with `C --profile backup up -d`. Dumps go to the `backups` volume as `rss-reader-YYYYMMDD-HHMMSS.dump` and are pruned after `BACKUP_RETENTION_DAYS`.
- Take an ad-hoc dump with `C exec db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > rss-reader.dump`.
- Back up the `blobs` volume too, or let favicons and cached images re-fetch.

## Restore

1. `C stop server worker`
2. Restore one of:
   - From the backups volume: `C exec backup pg_restore --clean --if-exists -d "$POSTGRES_DB" /backups/<file>.dump`
   - From a local file: `C exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < rss-reader.dump`
3. `C start server worker`

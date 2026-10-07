# Self-hosting with Docker

Commands run from the repository root. `C` stands for `docker compose -f docker/compose.yaml`.

## Install

1. `cp docker/.env.example docker/.env`, set `POSTGRES_PASSWORD`, and set `APP_SECRET` to the output of `openssl rand -base64 48`.
2. Set `ADMIN_LOGIN` and `ADMIN_PASSWORD` for the first admin, or create it with the CLI after step 3.
3. `C up -d --build`

`migrate` runs once and exits. `server` and `worker` start after it succeeds. The app listens on `HTTP_PORT` (default 8080): open it in a browser and sign in. `GET /healthz` returns `200` with `{"status":"ok"}` when the database and job queue are reachable.

## Configuration

`docker/.env`:

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | — | Database credentials; also used to build `DATABASE_URL` |
| `APP_SECRET` | — | At least 32 characters; keys for encrypting stored 2FA secrets and feed passwords and for signing tokens. Back it up with the database: changing or losing it disables 2FA for every user and clears feed passwords |
| `HTTP_PORT` | `8080` | Host port for the server |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `PUBLIC_URL` | unset | The address readers use, e.g. `https://reader.example.com`; makes published-feed links absolute. Unset uses each request's address, which needs a proxy that forwards `Host` |
| `COMPAT_TRACE` | `false` | `true` logs every TTRSS and Google Reader API call with its parameters (credentials redacted), to diagnose a client |
| `TRUST_PROXY` | `false` | `true`, the number of proxy hops, or the reverse proxy's address/CIDR, so client IPs (login throttling) and HTTPS (secure cookies) come from forwarded headers |
| `FEED_UPDATE_INTERVAL_MINUTES` | `30` | Default minutes between fetches of a feed (5–1440) |
| `FEED_PURGE_DAYS` | `60` | Default age in days after which entries are deleted unless starred, published, noted, labelled, or shared; `0` keeps everything |
| `FEED_DISABLE_AFTER_FAILURES` | `20` | Consecutive failed fetches after which a feed is disabled until refreshed |
| `FETCH_ALLOW_PRIVATE_NETWORKS` | unset | Feeds on private or loopback addresses are blocked; set `true` or comma-separated CIDRs (e.g. `192.168.1.0/24`) to allow LAN feeds |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | unset | First admin, created at startup only while no users exist; remove once created |
| `BACKUP_RETENTION_DAYS` | `14` | Days of nightly dumps kept by the `backup` service |
| `RSS_READER_IMAGE` | `rss-reader:latest` | Image tag to build or run |
| `VIRTUAL_HOST`, `LETSENCRYPT_HOST` | unset | Public hostname for nginx-proxy and acme-companion (`compose.nginx-proxy.yaml`) |
| `NGINX_PROXY_NETWORK` | `nginx-proxy` | Existing Docker network of nginx-proxy |

Application variables, set in `compose.yaml`:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection URL |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | Server bind address inside the container |
| `BLOB_DIR` | `/data/blobs` | Favicon and image cache (`blobs` volume) |

## Users

Admins manage users through the admin API (`/api/v1/admin/users`). From the host, with the stack running:

- Create: `echo 'the password' | C exec -T server rss-reader cli user create <login> [--admin]`
- Reset a password, sign the user out everywhere, and revoke their app passwords: `echo 'new password' | C exec -T server rss-reader cli user reset-password <login>`
- Turn off a user's two-factor authentication and sign them out everywhere: `C exec server rss-reader cli user reset-2fa <login>`

## Logs

`C logs server worker` shows JSON logs. Warnings from the server about slowness:

| Message | Meaning |
|---|---|
| `Slow request` | A response took over 2 s |
| `Client closed the connection before the response was sent` | The browser or proxy gave up waiting |

Both include `pool` (`waiting` > 0: requests queued for a database connection) and `eventLoopDelayMaxMs` (high: the server was blocked). Neither high points at the database or at password hashing.

## Upgrade

`git pull && C up -d --build`. Migrations apply before the new server and worker start.

## Reverse proxy and TLS

### nginx-proxy

1. In `docker/.env`, set `VIRTUAL_HOST` (and `LETSENCRYPT_HOST` when acme-companion issues certificates). If nginx-proxy's Docker network is not called `nginx-proxy`, set `NGINX_PROXY_NETWORK`.
2. Add the override file to every command: `C -f docker/compose.nginx-proxy.yaml up -d`.

The server then joins the proxy network and is not published on the host. `TRUST_PROXY` defaults to `1`, the proxy being the only hop.

### Other proxies

Forward to the server's port 8080 and pass `X-Forwarded-For` and `X-Forwarded-Proto`. Set `TRUST_PROXY` to the number of proxies in front of the server or to the proxy's address. `true` also trusts `X-Forwarded-For` entries sent by clients, which lets them evade per-IP login throttling.

`/api/v1/events` is a long-lived event stream. nginx and nginx-proxy need no extra configuration. Other proxies must not buffer its responses and must allow at least 30 s between bytes (the server sends a heartbeat every 25 s).

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

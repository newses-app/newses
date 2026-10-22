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
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`; `debug` and `trace` log request, feed, page, and image URLs (secret keys stay redacted), which reach OTLP too when it is on |
| `PUBLIC_URL` | unset | The address readers use, e.g. `https://reader.example.com`; makes published-feed links absolute. Unset uses each request's address, which needs a proxy that forwards `Host` |
| `INSTANCE_NAME` | unset | What the desktop and Android apps call this server, e.g. `Home` (up to 100 characters), naming its profiles `user @ Home`; unset uses the host |
| `COMPAT_TRACE` | `false` | `true` logs every TTRSS and Google Reader API call with its parameters (credentials redacted), to diagnose a client |
| `TRUST_PROXY` | `false` | `true`, the number of proxy hops, or the reverse proxy's address/CIDR, so client IPs (login throttling) and HTTPS (secure cookies) come from forwarded headers |
| `FEED_UPDATE_INTERVAL_MINUTES` | `30` | Default minutes between fetches of a feed (5–1440) |
| `FEED_PURGE_DAYS` | `180` | Default age in days after which entries are deleted unless starred, published, noted, labelled, or shared; `0` keeps everything |
| `ARCHIVE_ENABLED` | `true` | Keeps entries that purge deletes in a cold-storage archive in the `blobs` volume, where users browse and restore them; `false` deletes them for good |
| `FEED_DISABLE_AFTER_FAILURES` | `20` | Consecutive failed fetches after which a feed is disabled until refreshed |
| `FETCH_ALLOW_PRIVATE_NETWORKS` | unset | Feeds on private or loopback addresses are blocked; set `true` or comma-separated CIDRs (e.g. `192.168.1.0/24`) to allow LAN feeds |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | unset | First admin, created at startup only while no users exist; remove once created. Well-known logins such as `admin` and `root` are refused |
| `BACKUP_RETENTION_DAYS` | `14` | Days of nightly dumps kept by the `backup` service |
| `OPS_RETENTION_DAYS` | `90` | Days of activity, request, site, and job statistics, and resolved alerts, kept for the Operations page |
| `AUDIT_RETENTION_DAYS` | `365` | Days of audit events kept |
| `OPS_HOST_HOURLY_BUDGET` | `200` | Requests to one site in an hour above which an alert opens |
| `SMTP_URL` | unset | Mail server for alert emails, e.g. `smtps://user:password@mail.example.com:465` |
| `ALERT_EMAIL_TO` | unset | Address alerts are emailed to; needs `SMTP_URL`. Unset keeps alerts on the Operations page only |
| `ALERT_EMAIL_FROM` | `Newses <newses@localhost>` | Sender of alert emails |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP/HTTP endpoint for traces, metrics, and logs, e.g. `http://lgtm:4318` for the `observability` profile; unset turns OpenTelemetry off |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Headers for the endpoint, e.g. `authorization=Bearer …` |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on`, `1` | Trace sampling, e.g. `parentbased_traceidratio` and `0.1` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | Milliseconds between metric exports |
| `DEPLOYMENT_ENVIRONMENT` | `self-hosted` | `deployment.environment.name` on all telemetry |
| `GRAFANA_PORT` | `3000` | Port of Grafana on `127.0.0.1` (`observability` profile) |
| `NEWSES_IMAGE` | `newses:latest` | Image tag to build or run |
| `COMPOSE_PROJECT_NAME` | `newses` | Prefix of container and volume names; a stack created as `rss-reader` keeps that name to keep its volumes |
| `VIRTUAL_HOST`, `LETSENCRYPT_HOST` | unset | Public hostname for nginx-proxy and acme-companion (`compose.nginx-proxy.yaml`) |
| `NGINX_PROXY_NETWORK` | `nginx-proxy` | Existing Docker network of nginx-proxy |

Application variables, set in `compose.yaml`:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection URL |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | Server bind address inside the container |
| `BLOB_DIR` | `/data/blobs` | Favicon and image cache, and the archive (`blobs` volume) |

## Users

Admins manage users through the admin API (`/api/v1/admin/users`). From the host, with the stack running:

- Create: `echo 'the password' | C exec -T server newses cli user create <login> [--admin]`
- Reset a password, sign the user out everywhere, and revoke their app passwords: `echo 'new password' | C exec -T server newses cli user reset-password <login>`
- Turn off a user's two-factor authentication and sign them out everywhere: `C exec server newses cli user reset-2fa <login>`

## Logs

`C logs server worker` shows JSON logs. Warnings from the server about slowness:

| Message | Meaning |
|---|---|
| `Slow request` | A response took over 2 s |
| `Client closed the connection before the response was sent` | The browser or proxy gave up waiting |

Both include `pool` (`waiting` > 0: requests queued for a database connection) and `eventLoopDelayMaxMs` (high: the server was blocked). Neither high points at the database or at password hashing.

With OpenTelemetry on, log lines inside a request or job carry `trace_id` and `span_id`.

## Monitoring

Admins open Settings > Operations:

| Tab | Shows |
|---|---|
| Alerts | Open alerts and those resolved in the last 7 days; a banner when the worker's checks stopped |
| Sites | Requests to each site in 24 hours or 7 days: outcomes, share answered "not modified", busiest hour against the budget, Retry-After pauses |
| Jobs | Runs, failures, and durations of feed fetches, favicons, full text, and the scheduled tasks |
| Users | Last seen, requests by app, and articles read over 7 and 30 days |
| Audit log | Sign-ins, failed sign-ins, password, 2FA, app-password, and user changes |

The worker checks for problems every 5 minutes and emails changes to `ALERT_EMAIL_TO` when `SMTP_URL` is set.

Traces, metrics, and logs:

1. Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318` in `docker/.env`.
2. `C --profile observability up -d`
3. Open `http://127.0.0.1:3000` (on the Docker host; tunnel with `ssh -L 3000:127.0.0.1:3000` from elsewhere). Grafana allows anonymous admin access, so keep it off public interfaces. The `newses` folder has dashboards for the overview, API, jobs, remote sites, and runtime; Explore searches traces (Tempo) and logs (Loki).

Any OTLP/HTTP backend works instead of the bundled one. Telemetry carries route patterns and host names, never credentials, feed URLs, or article content.

## Upgrade

`git pull && C up -d --build`. Migrations apply before the new server and worker start.

## Reverse proxy and TLS

### nginx-proxy

1. In `docker/.env`, set `VIRTUAL_HOST` (and `LETSENCRYPT_HOST` when acme-companion issues certificates). If nginx-proxy's Docker network is not called `nginx-proxy`, set `NGINX_PROXY_NETWORK`.
2. Add the override file to every command: `C -f docker/compose.nginx-proxy.yaml up -d`.

The server then joins the proxy network and is not published on the host. `TRUST_PROXY` defaults to `1`, the proxy being the only hop.

### Other proxies

Forward to the server's port 8080 and pass `X-Forwarded-For` and `X-Forwarded-Proto`. Set `TRUST_PROXY` to the number of proxies in front of the server or to the proxy's address. `true` also trusts `X-Forwarded-For` entries sent by clients, which lets them evade per-IP login throttling.

The desktop and mobile apps need HTTPS. The proxy must forward the `Authorization` and `Origin` headers and `OPTIONS` requests, which carry the apps' bearer tokens and CORS preflights.

`/api/v1/events` is a long-lived event stream. nginx and nginx-proxy need no extra configuration. Other proxies must not buffer its responses and must allow at least 30 s between bytes (the server sends a heartbeat every 25 s).

## Apps

Install the desktop and Android apps from an AWS stage's `https://<domain>/downloads/` (see `docs/architecture.md`) and enter the server's HTTPS address at first launch; they update themselves from there. The proxy needs the headers above.

## Backups

- Enable nightly dumps with `C --profile backup up -d`. Dumps go to the `backups` volume as `newses-YYYYMMDD-HHMMSS.dump` and are pruned after `BACKUP_RETENTION_DAYS`.
- Take an ad-hoc dump with `C exec db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > newses.dump`.
- Back up the `blobs` volume too. Favicons and cached images re-fetch, but the archive (`archive/` in the volume) is not in the dumps and cannot be re-fetched. `scripts/export-instance.sh` writes both to one bundle, which `scripts/restore-instance.sh` loads (below).

## Restore

1. `C stop server worker`
2. Restore one of:
   - From the backups volume: `C exec backup pg_restore --clean --if-exists -d "$POSTGRES_DB" /backups/<file>.dump`
   - From a local file: `C exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < newses.dump`
3. `C start server worker`

## Moving to another instance

Moves everything to another Docker host or an AWS stage, or from an AWS stage to Docker (`--aws dev|prod` on either script; bundle contents in `docs/architecture.md`). The target must run the same version of Newses or a newer one.

1. Start the target: `C up -d` on the new host, with its own `APP_SECRET`.
2. On the source: `scripts/export-instance.sh newses-bundle --freeze`. The source stays stopped; `C start server worker` restarts it. Without `--freeze` it keeps running, and changes after the export are lost.
3. Copy `newses-bundle/` to the target host privately (it holds password hashes and the source's `APP_SECRET`), e.g. `scp -r`.
4. On the target: `scripts/restore-instance.sh newses-bundle --dry-run`, then without `--dry-run`. The target's database is saved first as `newses-pre-restore-<time>.dump`.
5. Point DNS or the proxy at the target, and set `PUBLIC_URL` there if the address changed.
6. Delete the bundle.

Everyone signs in again, two-factor authentication included; the apps need the new address if it changed. `COMPOSE_PROJECT_NAME` and `COMPOSE_ENV_FILES` select a stack other than `docker/`'s.

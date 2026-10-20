# AGENTS.md

Newses: a self-hosted RSS reader replacing Tiny Tiny RSS. TypeScript monorepo: Node server + worker (PostgreSQL), Vue 3 + Vuetify web app, Electron and Capacitor shells. Deploys via Docker (self-hosted) or serverless AWS.

## Commands

| Command | Does |
|---|---|
| `nvm use` | Switch to Node 24 (`.nvmrc`) |
| `pnpm install` | Install and link workspace packages |
| `pnpm check` | Lint, typecheck, format check, tests (run before every commit; the AWS pipeline runs the same) |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format` | Individual steps |
| `pnpm --filter @newses/server db:generate` | Generate a SQL migration from `server/src/db/schema.ts` changes (`--name x`; add `--custom` for hand-written SQL) |
| `DATABASE_URL=… pnpm --filter @newses/server db:migrate` | Apply migrations |
| `docker compose -f docker/compose.yaml --profile observability up -d` | Local stack with Grafana, Tempo, Loki, and Prometheus on `127.0.0.1:3000`; set `OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318` in `docker/.env` |
| `pnpm --filter @newses/web dev` | Web app with hot reload; proxies `/api` to a server on `localhost:8080` |
| `pnpm --filter @newses/web build:native` | Web app for the desktop and mobile apps, in `web/dist-native` |
| `pnpm --filter @newses/desktop dev` | Desktop app against the web app's dev server, with hot reload |
| `pnpm --filter @newses/desktop build:linux` / `build:win` | Unsigned desktop packages in `desktop/release` (AppImage and deb; NSIS installer, built on Windows) |
| `pnpm --filter @newses/desktop build:win:signed` | Signed NSIS installer (on Windows), with the values in `desktop/electron-builder.env` |
| `scripts/windows-signing-setup.sh` | Creates the release pipeline's Azure app registration and signer role on the existing Artifact Signing profile; writes `desktop/electron-builder.env`, and SSM parameters with `--ssm` (`--help`) |
| `pnpm --filter @newses/mobile build:apk` / `install:apk` | Unsigned debug APK in `mobile/release` (needs JDK 21 and the Android SDK); `install:apk` also installs it with `adb` |
| `pnpm --filter @newses/mobile build:apk:release` | Release APK in `mobile/release`, signed with the values in `mobile/android-signing.env` (unsigned without them) |
| `scripts/android-signing-setup.sh --backup DIR` | Generates the Android release keystore in an offline backup folder (or reuses it there); writes `mobile/android-signing.env`, and SSM parameters with `--ssm` (`--help`) |
| `E2E_BASE_URL=… pnpm --filter @newses/web test:e2e` | Playwright tests against a running deployment with subscriptions (`E2E_LOGIN`, `E2E_PASSWORD`); not part of `pnpm check` |
| `pnpm --filter @newses/infra cdk synth` | Synthesise the AWS stacks and pipelines (build `web` first); deployments run through the pipelines |
| `aws ssm put-parameter --name /<prefix>/deploy-config --type String --overwrite --value file://infra/deploy.config.json` | Store the AWS deployment config (gitignored; copy `infra/deploy.config.example.json`) where the pipelines' synth reads it; needed by `cdk` and the AWS scripts locally too |
| `git tag v1.2.3-rc.1 && git push origin v1.2.3-rc.1` | Release the apps to the dev stage (prerelease tags) or, with `v1.2.3`, to prod; the stage's release pipeline builds, signs, and publishes to `/downloads/`. Prereleases must be `-rc.1` to `-rc.98`, each a higher Android versionCode than the last and below the release |
| `scripts/reset-stage.sh dev\|prod` | Empties an AWS stage (`--dry-run` shows what it would delete): drops the database schema, re-runs `migrate` (admin `adminLogin`, password from SSM `admin-password`), empties the blob bucket, purges the queues; keeps SSM parameters and downloads; snapshots prod first (`--help`) |
| `aws lambda invoke --function-name <prefix>-<stage>-migrate --payload '{"task":"reissue-admin"}' --cli-binary-format raw-in-base64-out /dev/null` | Gives a stage's first admin a new generated password in SSM `admin-password` once theirs has expired; refused while another admin is active |
| `aws sns subscribe --topic-arn arn:aws:sns:<region>:<account>:<prefix>-<stage>-alerts --protocol email --notification-endpoint ADDRESS` | Emails a stage's operations alerts to ADDRESS, once confirmed from the email AWS sends; the topic `<prefix>-budget` carries the project budget's notifications |
| `scripts/try-release.sh` | Run the dev release legs on the working tree without a tag; the publish is a dry run unless `--publish` (`--help`) |
| `scripts/sbom.sh` | CycloneDX SBOMs of the server, Docker image, web, desktop, and mobile apps in `sbom/`, validated; `--upload` sends them to Dependency-Track (`DTRACK_URL`, default `http://localhost:8080`, and `DTRACK_API_KEY`, from the environment or `dtrack.env`), `--from URL` a published release's (`--help`) |

## Code conventions

- Node runs `.ts` directly: erasable syntax only (no enums, namespaces, parameter properties); relative imports use the `.ts` extension; workspace packages export `./src/index.ts`.
- Tests live next to code as `*.test.ts` (Vitest). Database tests start a Postgres container via Testcontainers, so Docker must be running.
- Migrations are generated, never edited after they are committed; change the schema and generate a new one.
- `web` is bundled by Vite; browser code imports runtime values from `@newses/shared/client` (no Zod) and only types from `@newses/shared`. UI strings live in `web/src/locales/en.json`.
- A new workspace package is a top-level folder, registered in `pnpm-workspace.yaml` and `vitest.config.ts` `projects`.

## Commits

- Agents never commit, amend, or push on their own. Leave changes in the working tree for the maintainer's review, and commit only when asked.

## Docs map

| Doc | Owns |
|---|---|
| `docs/requirements.md` | What the product does: features, phases, non-functional requirements, non-goals |
| `docs/architecture.md` | How it is built and deployed: stack, layout, components, data model concepts, APIs, deployment |
| `docs/self-hosting.md` | Operating a Docker deployment: install, configuration, upgrade, proxy, backup, restore |
| `docs/migration-ttrss.md` | Importing data from an existing TTRSS instance |
| `docs/adr/` | Decision history |

Put each new fact in the doc that owns it. Never state the same fact in two places.

## Doc rules

- Current state only. When something changes, edit the doc in place.
- No history, alternatives, rationale narratives, dates, status, or ADR references in docs.
- Tables and bullets. No preambles, summaries, or filler.
- Delete stale content; don't annotate it.
- Code is authoritative once it exists (Drizzle schema, generated OpenAPI). Docs keep only concepts and constraints code doesn't express.

## ADRs

Write an ADR for decisions that change: stack, architecture, data model concepts, API surface, hosting, security model, or a feature's scope/phase. Not for routine implementation choices.

- File: `docs/adr/NNNN-kebab-title.md`, next sequential number.
- Template: `# NNNN. Title`, then `Status`, `Date`, `Context`, `Decision`, `Consequences`. Keep to ~20 lines.
- Accepted ADRs are immutable. To change a decision, write a new ADR with `Supersedes NNNN` and set the old one's status to `Superseded by NNNN` (the only permitted edit).
- Update affected docs in the same change so they reflect the new current state.

## Tracking

Progress, TODOs, and open questions go in GitHub Issues and milestones, never in docs.

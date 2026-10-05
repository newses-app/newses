# AGENTS.md

Self-hosted RSS reader replacing Tiny Tiny RSS. TypeScript monorepo: Node server + worker (PostgreSQL), Vue 3 + Vuetify web app, Electron and Capacitor shells. Deploys via Docker (self-hosted) or serverless AWS.

## Commands

| Command | Does |
|---|---|
| `nvm use` | Switch to Node 24 (`.nvmrc`) |
| `pnpm install` | Install and link workspace packages |
| `pnpm check` | Lint, typecheck, format check, tests (run before every commit; the AWS pipeline runs the same) |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm format` | Individual steps |
| `pnpm --filter @rss-reader/server db:generate` | Generate a SQL migration from `server/src/db/schema.ts` changes (`--name x`; add `--custom` for hand-written SQL) |
| `DATABASE_URL=… pnpm --filter @rss-reader/server db:migrate` | Apply migrations |
| `pnpm --filter @rss-reader/web dev` | Web app with hot reload; proxies `/api` to a server on `localhost:8080` |
| `E2E_BASE_URL=… pnpm --filter @rss-reader/web test:e2e` | Playwright tests against a running deployment with subscriptions (`E2E_LOGIN`, `E2E_PASSWORD`); not part of `pnpm check` |
| `pnpm --filter @rss-reader/infra cdk synth` | Synthesise the AWS stacks and pipelines (build `web` first); deployments run through the pipelines |

## Code conventions

- Node runs `.ts` directly: erasable syntax only (no enums, namespaces, parameter properties); relative imports use the `.ts` extension; workspace packages export `./src/index.ts`.
- Tests live next to code as `*.test.ts` (Vitest). Database tests start a Postgres container via Testcontainers, so Docker must be running.
- Migrations are generated, never edited after they are committed; change the schema and generate a new one.
- `web` is bundled by Vite; browser code imports runtime values from `@rss-reader/shared/client` (no Zod) and only types from `@rss-reader/shared`. UI strings live in `web/src/locales/en.json`.
- A new workspace package is a top-level folder, registered in `pnpm-workspace.yaml` and `vitest.config.ts` `projects`.

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

Progress, TODOs, and open questions go in GitHub Issues and milestones (`P1`, `P1.5`, `P1.6`, `P2`, `P3`, `P4`, `Later`), never in docs.

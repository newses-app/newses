# 0018. Package boundaries at runtime and toolchain lines

- Status: Accepted
- Date: 2026-10-03

## Context
The first scaffold split server code into separate workspace packages (core, db, adapters, worker, importer). All of them ship in one server image and have no other consumers. Each package adds manifests, tsconfig, a separate type-check run, and friction when moving code.

## Decision
- Workspace packages exist only where runtime or toolchain differs: `server`, `web`, `desktop`, `mobile`, `shared`, `infra`, each a top-level folder (no `apps/`/`packages/` grouping, as no further shared libraries are planned).
- Server layers (`core`, `db`, `adapters`, `api`, `importer`, `entrypoints`) are folders in `server/src`.
- Their allowed import directions are enforced by ESLint (`import-x/no-restricted-paths`). `core` is also barred from framework and cloud SDK imports.

## Consequences
- Fewer manifests and a single type-check run for server code.
- Layering is enforced by lint rather than by package resolution, so it relies on lint running in CI.

# 0014. Dual hosting via ports and adapters

- Status: Accepted
- Date: 2026-10-03

## Context
The server must run self-hosted with Docker and on AWS. AWS may later move to serverless.

## Decision
- Core logic depends on ports (`JobQueue`, `Scheduler`, `BlobStore`, `Realtime`, `Config`), each with per-environment adapters.
- Servers are stateless, with no local-disk state outside `BlobStore`.
- Migrations run as a separate command.
- The SPA is a standalone static build.

## Consequences
- The same image runs in both environments.
- Adding a runtime means adding adapters, not rewriting the core.
- The abstractions add a small amount of indirection.

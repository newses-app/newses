# 0002. TypeScript pnpm monorepo

- Status: Accepted
- Date: 2026-10-03

## Context
Server, worker, web, desktop, mobile, importer, and infrastructure share types and domain logic. The owner prefers Node.js and briefly considered plain JavaScript.

## Decision
TypeScript (strict, ESM) everywhere, including CDK. Node 24 LTS. One repository using pnpm workspaces, split into `apps/*` and `packages/*`.

## Consequences
- Shared Zod schemas and types flow from the database to the UI.
- One lockfile and one CI pipeline.
- Each package needs a build step.

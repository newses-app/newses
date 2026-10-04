# 0017. TypeScript monorepo run by Node's native type stripping

- Status: Accepted
- Date: 2026-10-03
- Supersedes: 0002

## Context
0002 chose a TypeScript pnpm monorepo, which implied a build step for every package. Node 24 strips erasable TypeScript syntax natively, including in workspace packages linked through pnpm. TypeScript 7 (native compiler) is not yet supported by typescript-eslint.

## Decision
- TypeScript everywhere (strict, ESM, Node 24 LTS), in one pnpm workspaces repository with one top-level folder per workspace package.
- Node packages export `.ts` sources and run directly with no build step. Code uses erasable syntax only (no enums, namespaces, or parameter properties), and relative imports include the `.ts` extension.
- `tsc` is used for type checking only (`noEmit`). The web app is built with Vite.
- Pin TypeScript to 6.0.x until typescript-eslint supports 7.

## Consequences
- No compile step in development or in the Docker image.
- Shared types flow from database to UI.
- Some TypeScript syntax is unavailable.

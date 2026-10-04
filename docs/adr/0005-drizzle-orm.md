# 0005. Drizzle ORM

- Status: Accepted
- Date: 2026-10-03

## Context
The schema needs PostgreSQL-specific features (generated `tsvector` columns, partial indexes). Hot-path headline queries need close control over SQL. Prisma, Kysely, and Drizzle were the candidates.

## Decision
Drizzle ORM for schema and queries; drizzle-kit for generated SQL migrations.

## Consequences
- The TypeScript schema is the authoritative data model.
- SQL stays visible, and raw SQL is available where the builder falls short.
- The Aurora Data API driver is available for a future Lambda variant.

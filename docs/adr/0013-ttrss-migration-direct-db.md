# 0013. TTRSS migration by direct database read

- Status: Accepted
- Date: 2026-10-03

## Context
The alternatives lose data:
- OPML carries no article state.
- The TTRSS API omits filters and preferences.
The owner has full access to the TTRSS PostgreSQL database.

## Decision
- A CLI importer reads the TTRSS schema directly, preferably from a restored dump.
- It is read-only on the source.
- It is idempotent through `import_map` and finishes with a reconciliation report.

## Consequences
- Full-fidelity migration.
- The importer is coupled to TTRSS schema versions and checks `schema_version`.
- PCRE filters need translation, and some cannot be imported.

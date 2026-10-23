# 0001. Documentation conventions

- Status: Superseded by 0079
- Date: 2026-10-03

## Context
Planning documents tend to duplicate each other and fill up with history, which leaves readers unsure what is current.

## Decision
- Three current-state docs: `requirements.md`, `architecture.md`, `migration-ttrss.md`. Each fact lives in exactly one of them.
- Docs contain no history, alternatives, rationale, dates, status, or ADR references.
- Decision history lives only in immutable ADRs. Changes are made by superseding ADRs.
- Once code exists, it is authoritative (schema, OpenAPI).
- Progress and open questions are tracked in GitHub Issues.
- `AGENTS.md` holds the working rules; `CLAUDE.md` imports it.

## Consequences
Every decision change updates both a new ADR and the affected docs in one change. Docs stay short and can be trusted as current.

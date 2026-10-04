# 0012. TTRSS and Google Reader compatibility APIs

- Status: Accepted
- Date: 2026-10-03

## Context
Users rely on existing mobile clients. The TTRSS API keeps current TTRSS apps working through cut-over. The Google Reader API is the de facto standard for third-party readers. Fever offers little beyond those.

## Decision
- Implement a TTRSS-compatible `/api/` and the Google Reader API as adapters over the core services, authenticated with app passwords.
- Do not implement Fever.

## Consequences
- Wide client support and a smooth migration.
- Two protocol surfaces to test against real clients.
- Fever-only clients are unsupported.

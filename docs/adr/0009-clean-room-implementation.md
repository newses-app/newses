# 0009. Clean-room implementation

- Status: Accepted
- Date: 2026-10-03

## Context
TTRSS is GPLv3. This project reimplements its features and APIs and reads its database.

## Decision
- No TTRSS source code is copied or translated.
- Compatibility APIs are built from public API documentation and observed client behaviour.
- The importer depends only on TTRSS's database schema.

## Consequences
The project's own license can be chosen freely. Compatibility edge cases are found by testing with real clients rather than by reading TTRSS code.

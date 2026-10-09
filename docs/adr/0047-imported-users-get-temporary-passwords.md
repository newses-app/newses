# 0047. Imported users get temporary passwords

- Status: Accepted
- Date: 2026-10-08

## Context
TTRSS users have password hashes in TTRSS's own formats. Verifying them here needs TTRSS's exact hashing scheme, which would come from its code (0009). The family is small, and the new instance already has an administrator, created at bootstrap, who is usually also TTRSS's administrator.

## Decision
- The importer does not carry password hashes over. Each new user gets a generated temporary password, printed once in the import report, and must change it at first sign-in (0038).
- A user here whose login matches a TTRSS user's, ignoring case, is adopted. The import fills that account and keeps its password and role.
- Users already imported are not changed by re-runs.

## Consequences
- The operator hands each family member their temporary password at cut-over.
- No TTRSS password hash is stored here or needs a legacy verifier.
- TTRSS role changes after the first import are not applied.

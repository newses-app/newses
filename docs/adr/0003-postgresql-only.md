# 0003. PostgreSQL only

- Status: Accepted
- Date: 2026-10-03

## Context
Both PostgreSQL and MariaDB were acceptable. Supporting both would double the test matrix and force lowest-common-denominator full-text search and queueing. The existing TTRSS instance runs on PostgreSQL.

## Decision
Support PostgreSQL only (target version 18).

## Consequences
- Free use of `tsvector`/GIN search, JSONB, partial indexes, advisory locks, and a Postgres-backed job queue.
- RDS PostgreSQL on AWS.
- MariaDB users are not served.

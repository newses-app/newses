# 0006. pg-boss job queue

- Status: Accepted
- Date: 2026-10-03

## Context
Feed fetching, purging, readability, and favicon work run in the background with retries. Redis would add a service to self-host and pay for on AWS.

## Decision
Use pg-boss on the main PostgreSQL database, behind the `JobQueue` port.

## Consequences
- No extra infrastructure, and jobs are transactional with application data.
- Requires a long-running worker, which suits Docker and Fargate. A Lambda deployment needs an SQS adapter.

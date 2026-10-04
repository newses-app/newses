# 0021. Realtime events over Postgres LISTEN/NOTIFY

- Status: Accepted
- Date: 2026-10-04

## Context
The worker ingests entries, but clients hold SSE connections to the server, which is a separate process (and on AWS, a separate task). An in-memory event emitter cannot cross that boundary. Redis pub/sub would add infrastructure.

## Decision
- The `Realtime` adapter publishes with `pg_notify` on a single channel. Each server process holds one `LISTEN` connection and fans events out to its SSE clients.
- Events are small per-user invalidation signals (for example `{ type: 'counters' }`). Clients refetch the data.

## Consequences
- No extra infrastructure, and it works the same under Docker and Fargate.
- Payloads must stay under 8000 bytes.
- Each server process uses one extra database connection.
- Events published while a listener is reconnecting are lost; clients' polling fallback covers the gap.

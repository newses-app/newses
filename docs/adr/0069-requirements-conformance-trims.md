# 0069. Requirements trimmed after a conformance review

- Status: Accepted
- Date: 2026-10-18

## Context
A review of the requirements against the code found that nothing measures the Performance targets (headline list, article open, and ingest times) or the full-text search time on 1M entries, and that the TTRSS import report has never reconciled unread, starred, or published counts. The TTRSS cut-over is done.

## Decision
- The numeric performance and search targets are dropped; latency is watched through the observed p95 and slow-request logs.
- The TTRSS import report reconciles entries, labels, and notes, without unread, starred, or published counts.

## Consequences
- Performance regressions show in monitoring rather than failing a check.
- A re-run import cannot confirm per-user read and star state from the report alone.

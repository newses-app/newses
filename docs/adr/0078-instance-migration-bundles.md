# 0078. Moving an instance through bundles

- Status: Accepted
- Date: 2026-10-21

## Context
Operators move a Newses instance between the Docker stack and AWS stages, or between stages: to a new host, to AWS, or to copy prod into dev. Only TTRSS imports existed. Docker dumps leave out the blob volume, RDS snapshots cannot leave RDS and hold both stages, and TOTP secrets are sealed with the instance's `APP_SECRET` (0034).

## Decision
- A whole-instance clone, not a per-user merge: the target's data is replaced, keeping ids, so share links, access keys, app passwords, and sync state stay valid.
- Export and restore are separate steps through a bundle directory (`scripts/export-instance.sh`, `scripts/restore-instance.sh`), so no machine needs to reach both ends, and the bundle doubles as an offline backup of an AWS stage.
- The target keeps its own `APP_SECRET`; `cli reseal-secrets` re-seals TOTP secrets with it, using the source's secret from the bundle.
- Sessions, login throttling, rate limits, operations data, and queued jobs are not carried over: everyone signs in again.
- The database is replaced in one transaction; the target must already have the bundle's migrations and applies its newer ones afterwards.
- AWS stages are frozen during a restore, and optionally for an export, by reserved concurrency 0 and disabled queue mappings (`scripts/freeze-stage.sh`).

## Consequences
- Merging users into an instance that already has data is not supported.
- A bundle is as sensitive as the instance: it holds password hashes and the source's `APP_SECRET`.
- A stage being restored or frozen answers API requests with errors until it is started again.
- A source left running during an export loses the changes made after it.

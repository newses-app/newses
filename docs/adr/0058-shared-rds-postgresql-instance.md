# 0058. Shared RDS PostgreSQL instance and runtime budget

- Status: Accepted
- Date: 2026-10-12
- Supersedes 0031, 0057

## Context
ADR 0031 chose Aurora Serverless v2 at 0 ACU so an idle stage would cost a few dollars a month. Measured on both stages, it costs about $1 a day each. Dispatch wakes the database every 30 minutes. Each wake runs about 6 minutes at 1.5 ACU, then 5–10 minutes at 0.5 ACU before pausing again. That is about 0.18 ACU-h ($0.022) per wake, whatever the work. A db.t4g.micro with 20 GB gp3 costs $13.98 a month, the same as about 21 wakes a day. ADR 0057's $10 budget over everything tagged `project=rss-reader` also counted CodeBuild and CodePipeline. Those are development costs, not the cost of running the reader. The rest of 0031 and 0057 stands.

## Decision
- One RDS PostgreSQL 18 db.t4g.micro instance holds every stage's database:

  | Setting | Value |
  |---|---|
  | Availability | Single-AZ |
  | Storage | 20 GB gp3, growing to 50 GB |
  | Backups | 14 days |
  | Protection | Deletion protection; final snapshot on removal |

- The instance is publicly reachable on 5432, with TLS required (`rds.force_ssl`), as Aurora was.
- It lives in shared stacks, `rss-reader-db-params` (the master password) and `rss-reader-db`. Both pipelines deploy them before their stage, as with the budget stack.
- Stages read the instance's address from the SSM parameter `/rss-reader/db/endpoint`.
- Each stage has its own database and login role, `rss_reader_<stage>`, which owns that database. `PUBLIC` loses `CONNECT` on it.
- The stage's `migrate` function creates the role and database as the master user, then migrates as the stage role.
- The budget covers spend tagged `project=rss-reader` except the CodeBuild and CodePipeline services, with a $25 limit.

## Consequences
- The database costs about $14 a month plus $3.65 for its public IPv4 address, for both stages together. That cost stays flat whatever the dispatch cadence or app sync rate.
- There are no resume waits.
- One instance is always running; compute stays serverless.
- Dev and prod share CPU credits, maintenance windows, and engine upgrades.
- A change to the shared stacks reaches prod's data when `dev` deploys.
- A snapshot of the instance covers both stages.
- Pipeline artifacts in S3 still count against the budget; they are a few cents a month.

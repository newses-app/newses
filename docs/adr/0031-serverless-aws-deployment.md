# 0031. Serverless AWS deployment

- Status: Superseded by 0058
- Date: 2026-10-05
- Supersedes 0015, 0016, 0022

## Context
The AWS deployment must cost next to nothing while idle: no running instances. 0015's Fargate services, ALB, and RDS instance run around the clock (~$45–60/month per stage).

## Decision
- Compute is Lambda (ARM64, Node 24, outside any VPC): an HTTP API function wrapping `buildApp()`, SQS-triggered fetch and favicon functions, a tick function run by EventBridge Scheduler (dispatch every 30 min; purge and auth prune on dispatch times), and a migrate function run by a CDK trigger before the others update.
- The database is Aurora Serverless v2 PostgreSQL scaling to 0 ACU after 5 idle minutes. It is publicly reachable over TLS only (`rds.force_ssl`) with a generated password, because Lambdas outside a VPC need no NAT; node-postgres stays the only driver.
- CloudFront serves the static SPA from a private S3 bucket and routes API paths to the HTTP API with a secret origin header the API requires. Blobs live in S3. There is no realtime stream; clients poll.
- CDK in TypeScript in `infra/`, stacks `Data`, `App`, `Edge`, and a us-east-1 `Cert` stack per stage. Account `123456789012`, region `us-east-2`, Route 53 zone `example.com`.
- One self-mutating CDK pipeline per stage, with no GitHub workflows: branch `dev` deploys `dev` (`reader-dev.example.com`), branch `main` deploys `prod` (`reader.example.com`). Merging to `main` is the production approval. Each run executes `pnpm check`, builds the SPA, bundles the Lambdas, deploys, and smoke-tests.

## Consequences
- Idle cost is storage, a public IPv4 address, and secrets: a few dollars a month per stage.
- The first request after the database pauses waits about 15 s for it to resume.
- Lambda responses are capped at 6 MB; lists with content end pages early.
- The database port is open to the internet; TLS and the generated password protect it.
- Docker self-hosting keeps pg-boss, timers, and LISTEN/NOTIFY; the core is shared.

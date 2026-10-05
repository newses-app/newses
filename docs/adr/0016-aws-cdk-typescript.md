# 0016. AWS CDK in TypeScript

- Status: Superseded by 0031
- Date: 2026-10-03

## Context
The AWS infrastructure needs infrastructure-as-code. The candidates were CDK, Terraform/OpenTofu, and SST.

## Decision
AWS CDK in TypeScript in `packages/infra`, with stacks `Network`, `Data`, `App`, `Edge` and stages `dev` and `prod`.

## Consequences
- Same language and tooling as the application, with high-level ECS, CloudFront, and RDS constructs.
- AWS-only, which is acceptable because self-hosting uses Docker Compose.

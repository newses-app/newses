# 0015. AWS: Fargate first, Lambda later

- Status: Superseded by 0031
- Date: 2026-10-03

## Context
Two AWS options were considered:
- **ECS Fargate** runs the existing image unchanged.
- **Lambda behind API Gateway** has these limits:
  - Breaks SSE.
  - Caps responses at 6 MB.
  - Needs an SQS/EventBridge job path.
  - Needs RDS Proxy or the Data API.
  - Needs NAT to fetch feeds from inside a VPC.

## Decision
- The SPA is served from S3 through CloudFront, which also routes the API paths to an ALB in front of ECS Fargate (`server` and `worker` services, ARM64, public subnets, no NAT).
- The database is RDS PostgreSQL; secrets are in Secrets Manager.
- Deployment follows the P1 MVP (milestone P1.5). The Lambda variant is deferred.

## Consequences
- Near-zero code changes for AWS.
- Estimated fixed cost at family scale is ~$45–60/month: RDS ~$15, ALB ~$17, Fargate ~$10–20, public IPv4 ~$4–8.

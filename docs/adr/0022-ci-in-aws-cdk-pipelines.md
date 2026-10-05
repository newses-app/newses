# 0022. CI/CD in AWS via CDK Pipelines

- Status: Superseded by 0031
- Date: 2026-10-04

## Context
The scaffold added a GitHub Actions workflow for checks and image builds. The owner wants all building and CI to live in AWS, defined with CDK like the rest of the infrastructure.

## Decision
- No GitHub workflows.
- A CDK Pipelines app in `infra/` (CodePipeline + CodeBuild), sourced from the GitHub repository, runs `pnpm check`, builds the image to ECR and the SPA to S3, and deploys the `dev` and `prod` stages.
- Until that pipeline exists (P1.5), `pnpm check` is run locally before each commit.

## Consequences
- Build, test, and deploy share one AWS-native toolchain and IAM model.
- No automated checks on pushes until P1.5.
- Self-hosters build the image locally (`docker compose build`).

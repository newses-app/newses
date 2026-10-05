# 0033. SSM Parameter Store for deployment secrets

- Status: Accepted
- Date: 2026-10-05

## Context
Each AWS stage kept three Secrets Manager secrets (database credentials, CloudFront origin header, first admin) at $0.40/month each, a large share of the idle cost targeted by 0031. Nothing uses rotation.

## Decision
- Generated credentials are Standard SSM parameters under `/rss-reader/<stage>/`, encrypted with the AWS-managed `aws/ssm` key where SecureString.
- A custom resource writes a random value once on create and deletes it with the stack; CloudFormation can neither generate values nor create SecureString parameters.
- Aurora's master password resolves from `db-password` via `ssm-secure`; Lambdas read parameters with `GetParameter` once per cold start.
- `origin-header` is a String parameter, because CloudFront custom headers cannot resolve SecureString parameters; the value is readable in the distribution config anyway.

## Consequences
- Secrets cost nothing per stage.
- No managed rotation; changing a value means replacing the parameter.
- Switching stages from Secrets Manager removes a cross-stack export, so live stages are recreated rather than updated.

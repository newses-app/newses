# 0057. AWS tracing, shared budget stack, and alert notifications

- Status: Accepted
- Date: 2026-10-12
- Supersedes 0056

## Context
ADR 0056 put the project budget in the prod stage, so it appeared only once `main` deployed and would go with prod's stacks. The budget covers the whole project, so it belongs to neither stage. The rest of 0056 stands: traces with a per-stage sampling rate, no CloudWatch metrics, alarms, or dashboards, and alert notifications, at near-zero cost in an account that cannot rely on free tiers and hosts other projects that use X-Ray.

## Decision
- Functions run the AWS Distro for OpenTelemetry Lambda layer when the stage's `traceSampling` is above 0. Its SDK samples by trace id at that rate (`traceidratio`) and sends spans to X-Ray through Lambda's local endpoint. Fast-start mode is not used: it has no sampler and drops span links.
- Lambda active tracing (not needed for spans from function code; its fixed rate would override the stage's), Application Signals, and X-Ray Transaction Search (an account-wide switch) stay off. Only the `aws-lambda` and `aws-sdk` instrumentations run: undici is never instrumented, so remote hosts never receive trace headers, and `http` would only duplicate the AWS SDK spans.
- Each SQS-triggered invocation keeps its own trace, its job span linked to the span that queued the job.
- No CloudWatch custom metrics, alarms, or dashboards; the Operations page is the dashboard on AWS as on Docker.
- One monthly AWS Budget (notification only, free) covers everything tagged `project=rss-reader`. It lives in a stack of its own, `rss-reader-budget`, with its own SNS topic; both pipelines deploy it after their stage, from one project-wide limit (`BUDGET_USD`, $10).
- Each stage has an SNS alert topic, to which an `SnsNotifier` behind the `Notifier` port publishes alert changes from `tick`. Email subscriptions are added outside the stacks, so addresses stay out of the repository.

## Consequences
- The budget exists after either stage's first deployment and survives the removal of either stage.
- Both pipelines must synthesise the same budget resources, or each deployment would undo the other's; a test holds them equal (only CDK's path metadata differs, which CloudFormation does not update on its own). A limit changed on `dev` is reverted by the next `main` deployment until merged.
- Pipelines running at once can collide on the budget stack; a retry clears it.
- Tracing costs about $5 per million traced invocations; `traceSampling` 0 removes the layer and its cold-start cost.
- The budget misses untaggable charges such as X-Ray traces and tax. Notifications reach no one until an address subscribes to a topic.

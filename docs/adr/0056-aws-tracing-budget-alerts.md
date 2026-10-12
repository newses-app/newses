# 0056. AWS tracing, budget, and alert notifications

- Status: Accepted
- Date: 2026-10-12

## Context
ADR 0055 left AWS export open. The AWS deployment needs traces with a sampling rate set per stage, cost control, and alert notifications, at near-zero cost in an account that cannot rely on free tiers and also hosts other projects that use X-Ray. Lambda active tracing is not needed for spans from function code, and its fixed rate (1 request per second plus 5%, nearly every invocation at our volume) cannot be configured. X-Ray Transaction Search bills spans per GB but is an account-wide switch. CloudWatch custom metrics, alarms, and dashboards bill per metric and per month.

## Decision
- Functions run the AWS Distro for OpenTelemetry Lambda layer when the stage's `traceSampling` is above 0. Its SDK samples by trace id at that rate (`traceidratio`) and sends spans to X-Ray through Lambda's local endpoint. The layer's fast-start mode is not used: it has no sampler and drops span links.
- Lambda active tracing, Application Signals, and X-Ray Transaction Search stay off. Only the `aws-lambda` and `aws-sdk` instrumentations run: undici is never instrumented, so remote hosts never receive trace headers, and `http` would only duplicate the AWS SDK spans.
- Each SQS-triggered invocation keeps its own trace, its job span linked to the span that queued the job, so one invocation is one billed trace.
- No CloudWatch custom metrics, alarms, or dashboards; the Operations page is the dashboard on AWS as on Docker.
- One monthly AWS Budget (notification only, free) covers everything tagged `project=rss-reader`. Its limit is `budgetUsd` in the stage config; the stage that sets it (prod, $10) owns the budget.
- Each stage has an SNS alert topic. An `SnsNotifier` behind the `Notifier` port publishes alert changes from `tick`, and the budget notifies the owning stage's topic. Email subscriptions are added outside the stack, so addresses stay out of the repository.

## Consequences
- Tracing costs about $5 per million traced invocations; setting `traceSampling` to 0 removes the layer and its cold-start cost.
- `pg` is bundled and not auto-instrumented on Lambda; traces show requests, jobs, outbound fetches, and AWS SDK calls.
- The budget misses untaggable charges such as X-Ray traces and tax.
- Notifications reach no one until an address subscribes to the topic.

# 0098. Digests as queued jobs, with 5 minutes for plugins

- Status: Accepted
- Date: 2026-11-24
- Supersedes 0097

## Context
Plugins got 60 s to compose a digest, too little for a model reading thousands of articles in parts: the digest summary's slowest part ran past its share and the whole overview was dropped. Digests were sent inline, one user after another within a run's budget (4 minutes in the worker, 1 minute inside `tick`'s dispatch), so a longer limit would stall every user behind a slow one. Test digests were sent by the server process on Docker and by `tick`, invoked by `api`, on AWS.

## Decision
- `DIGEST_LIMITS.timeoutSeconds` is 300 (plugin API 0.1.1).
- The dispatch only claims due users, as before, and queues a `digest.send` job per user carrying its lease; test digests are `digest.send` jobs too. The worker runs them one at a time; on AWS the `digest` function runs them from an SQS queue, one per invocation and at most 2 at once (the least SQS allows), with a 10-minute timeout. Users are served in the order they became due.
- A job sends only while its claim holds, so duplicate deliveries send nothing; failures are not retried, and the lease lapsing lets a later dispatch claim the user again.
- Plugin actions stay as 0097 describes them.

## Consequences
- No Lambda invocations from code: the `api` function no longer needs `lambda:InvokeFunction` or the Lambda client, and only `api` and `digest` may send mail.
- A test digest waits behind digests queued before it; many slow digests at one hour reach the last users later.
- At most 4 database connections go to sending digests on AWS.

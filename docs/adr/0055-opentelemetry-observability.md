# 0055. OpenTelemetry and operations reporting

- Status: Accepted
- Date: 2026-10-12

## Context
The only operational signal was Pino logs. Operators need to see user activity, the load the reader puts on remote sites, job health, and security events, and to be alerted when something is wrong, on Docker and AWS alike. Telemetry must not leave the deployment unless the operator sends it somewhere, must not leak private feed URLs or credentials, and on AWS must cost next to nothing and never wake the paused database.

## Decision
- Code uses the OpenTelemetry API only. On Docker a preload (`node --import`) starts the Node SDK when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise no SDK loads. Traces, metrics, and logs go over OTLP. The compose file has an optional `observability` profile with `grafana/otel-lgtm` and provisioned dashboards.
- Outbound requests are traced by a fetcher decorator that records the host only; undici is not auto-instrumented, and no trace context is sent to remote hosts. Request spans are named by route; raw URLs are not recorded.
- Operations reporting that must work on every deployment lives in Postgres: hourly rollups of API requests, per-host fetches, and job runs; daily per-user activity; an audit table of security events. Admins read it on the Operations page. Metrics keep low-cardinality labels; per-host and per-user detail stays in these tables.
- Alerts are evaluated by the app (`ops.check`) over the rollups, kept in `ops_alerts`, shown on the Operations page, and sent through a `Notifier` port (SMTP on Docker when configured). On AWS the check rides the dispatch schedule.
- AWS export (ADOT layer, X-Ray, CloudWatch) is decided separately.

## Consequences
- One reporting and alerting path for both deployments; Grafana is optional.
- Every API invocation and job writes a few rollup rows; statistics are best effort and lost if a process dies before its flush.
- The privacy requirement allows telemetry only to endpoints the operator configures.

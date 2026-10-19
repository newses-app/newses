# 0070. Full URLs in logs only at debug

- Status: Accepted
- Date: 2026-10-18

## Context
Telemetry was to carry no credentials, feed URLs, or article content, but Fastify logged each request's raw URL at `info`, and with OTLP on Pino ships every line. Paths carry published-feed keys, share ids, icon tokens, signed image URLs, and the pages offered to publish; core logs named feed and page URLs. Diagnosing a feed or client sometimes needs the URL.

## Decision
- Request logs carry the route pattern, or `unmatched`; with `LOG_LEVEL` `debug` or `trace`, the URL itself.
- Routes name their secret parameters and query fields (published-feed keys, share ids, image signatures, icon tokens), which are redacted at every level.
- Log lines above debug name remote hosts, not feed, page, or image URLs; debug lines may carry them.
- `COMPAT_TRACE` stays an explicit opt-in that logs compatibility-API parameters, feed URLs included.

## Consequences
- Logs and OTLP at the default level hold no secret keys or feed URLs.
- Operators turn on debug, or the compatibility trace, to see addresses; doing so ships them to the configured telemetry too.

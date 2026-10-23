# 0079. Project site in a separate repository

- Status: Accepted
- Date: 2026-10-22
- Supersedes 0001

## Context
Newses needs a public home at `newses.app`: a landing page, user guides, contributor docs, and downloads. The user guides lived in `docs/` beside the planning docs, and anyone building or deploying the app should not have to build or deploy a site.

## Decision
- `newses-app/newses.app` holds the VitePress site (landing page, user guides, download page) and its own CDK app and pipeline. This repository, its Docker image, and its AWS deployment never build or depend on it.
- User guides (self-hosting, TTRSS migration, using Newses, third-party clients, apps) live in the site repository.
- This repository's current-state docs are `requirements.md` and `architecture.md`. The site pulls `docs/architecture.md`, `docs/adr/`, and `AGENTS.md` from the matching branch at build time and publishes them under `/contributing/`; `requirements.md` stays internal.
- Carried forward from 0001: each fact lives in exactly one doc; docs contain no history, alternatives, rationale, dates, status, or ADR references; decision history lives only in immutable ADRs, changed by superseding; code is authoritative once it exists; progress and open questions are tracked in GitHub Issues; `AGENTS.md` holds the working rules and `CLAUDE.md` imports it.
- The site runs in the app's AWS account in separate stacks, reusing the `newses.app` hosted zone, the `newses.app` / `*.newses.app` certificate, and the GitHub connection.
- One site at `newses.app` (`dev.newses.app` for the dev stage), with no analytics or cookies.

## Consequences
A change here to configuration, deployment, or import behaviour comes with a matching pull request in the site repository. Contributor pages update when the site's pipeline next runs, not on every push here.

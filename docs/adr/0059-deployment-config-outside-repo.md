# 0059. Open source as Newses, with the deployment config outside the repository

- Status: Accepted
- Date: 2026-10-12

## Context
The repository is to be published. The AWS deployment's account, region, GitHub connection, certificate, hosted zone, stage domains, and budget were constants in `infra/src/config.ts`, repeated in scripts, docs, and tests, and the apps carried a personal reverse-domain ID and author name. The generic name `rss-reader` made a unique app ID and project identity impossible; the project now owns `newses.app`.

## Decision
- The product is Newses: app ID `app.newses` (Android package, Capacitor, Electron, Windows AppUserModelId), packages `@newses/*`, the `newses` CLI, image, and compose project, `NEWSES_*` variables, the `app://newses` desktop origin, and the repository `newses-app/newses`. The author is "Newses contributors".
- `GET /server` reports `newses`; apps also accept `rss-reader` from servers not yet updated. The HKDF label `rss-reader/<purpose>` stays, since changing it changes every key derived from `APP_SECRET`.
- Account-specific values move to `infra/deploy.config.json`, which is not committed and is validated at synthesis. `infra/deploy.config.example.json` documents the shape with placeholder values, and tests synthesise against it.
- `resourcePrefix` in that config starts every AWS physical name, tag, and parameter path (`newses` in the example), so an existing deployment keeps its names.
- The pipelines' synth step writes the file from the String parameter `/<prefix>/deploy-config`; the values are not secret, only kept out of the repository. Stage-operating scripts read the same file.
- Published history is rewritten to replace the operator's values with placeholders.

## Consequences
- A fork deploys by writing its own config and storing it in the parameter; the code needs no edits.
- A config change applies on each pipeline's next run, not on push; the pipelines must be updated by hand once before the first synth that expects the parameter.
- Existing Android and Windows installs are a different app from `app.newses` and must be replaced once; a Docker stack keeps its volumes only by keeping its compose project name.
- Feed requests identify as `Newses/<version> (+https://newses.app)`.
- Every commit's hash changes with the rewrite; clones made before it must be re-cloned.

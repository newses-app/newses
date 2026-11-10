# 0085. Credits and third-party notices

- Status: Accepted
- Date: 2026-11-09

## Context
The apps bundle packages whose licences (MIT, Apache-2.0, OFL-1.1) require their notices to travel with them, and minified bundles drop the headers. Two themes adapt published palettes, and the password check ships a list from SecLists. Under AGPL-3.0 (ADR 0029), the apps' interactive UI should show the Appropriate Legal Notices (§5(d)), and users of a modified server must be offered its source (§13). Self-hosters run builds of their own.

## Decision
- An About tab in Settings, also public at `/about`, shows the versions, the AGPL notices, a source link, acknowledgements, and every bundled package's licence and NOTICE texts.
- Acknowledgements live in `shared/src/credits.ts`; `CREDITS.md` is generated from it.
- Each deliverable's licences are generated from what its build bundles (Rollup chunks, esbuild metafiles, installed `node_modules`, the APK's CycloneDX SBOM), not from `package.json`.
- The server reports its source as `source` in `GET /server`: `SOURCE_URL`, else the root `package.json` `repository` at the build's tag or commit. API 1.9.
- `GET /server/licenses` lists the server's packages to signed-in users only, so exact versions don't fingerprint the server for anyone.

## Consequences
- Forks link their own source by changing `repository` or setting `SOURCE_URL`.
- Android libraries carry no licence texts; their entries link to the licence.
- Apps hide the server's source link and licences against servers before 1.9.

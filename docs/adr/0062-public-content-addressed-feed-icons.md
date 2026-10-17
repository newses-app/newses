# 0062. Public, content-addressed feed icons

- Status: Accepted
- Date: 2026-10-17

## Context
The web app loaded each feed icon from `/api/v1/favicons/<source id>` with the session cookie. On AWS that path is an uncached API behaviour, so each icon was its own Lambda invocation. A tree of feeds started dozens of cold containers at once, and once they passed the account's Lambda concurrency, API Gateway answered 503. The apps used a signed per-user path instead, which went through Lambda the same way.

## Decision
- **Stored by content.** Icons are stored as `favicons/<sha256 of type and bytes>`. Sources of a site share one blob. An icon is deleted once no source shows it.
- **Public and cached for good.** `iconUrl` is `/<key>`.
  - No session and no per-user check: icons are sites' public favicons, and a key cannot be found without the icon itself.
  - Served `public, max-age` 1 year, immutable, sandboxed.
  - On AWS, CloudFront serves the path from the blob bucket through Origin Access Control. The bucket policy grants only `favicons/*`. The Docker server serves the same path from `BlobStore`.
- **Offline.** The service worker caches icons when first shown. The apps' WebViews keep them in their HTTP cache.
- API 1.3. The signed `/feed-icons` path stays for compatibility clients, and for the apps against older servers.

## Consequences
- Icons cost no Lambda or API Gateway requests on AWS. Edge misses are S3 GETs.
- Anyone with an icon's bytes can check whether some source on the instance shows it.
- Existing icons are re-checked once after the upgrade to move them to content keys.
- `/api/v1/favicons/:id` is no longer linked; it remains for clients that build it.

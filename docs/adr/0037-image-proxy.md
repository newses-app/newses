# 0037. Image proxy

- Status: Superseded by 0073
- Date: 2026-10-06

## Context
Entry images load from third-party hosts, which then learn each reader's address and reading times, and `http:` images trigger mixed-content blocking. Entry content is shared between users (0007), so a per-user choice cannot be applied at ingest. Native apps load `<img>` tags without their bearer token, and the AWS API must stay cheap.

## Decision
- A per-user `proxyImages` preference, off by default. Content is rewritten when served to such a user, not when stored.
- Proxied URLs are `/api/v1/images/<hmac>/<base64url URL>`, signed with the `image-url` key (0034). The signature is the authorisation: no session is needed, and the server never fetches a URL it did not sign.
- Images are fetched once through `HttpFetcher` within the polite-fetching limits (0026, 0030), cached in `BlobStore` with an `image_cache` index, failures remembered for 24 h, and everything purged after 30 days.
- Responses are public and immutable for 30 days; CloudFront caches the image path without cookies.
- Tracking pixels are dropped at ingest for every user, independent of the proxy.

## Consequences
- With the proxy on, image hosts see the server, not the reader, and pages make no third-party image requests.
- Anyone holding a proxied URL can load that image, which is no more than the original URL allowed.
- The first view of an image costs a server fetch; later views come from the edge or the blob store.
- Images over 4 MB are not shown when proxied.

# 0034. Application secret and encryption at rest

- Status: Accepted
- Date: 2026-10-06

## Context
TOTP seeds and HTTP-auth feed passwords must be readable by the server yet encrypted at rest, and image-proxy URLs and login challenges need tamper-proof signatures. Both hostings need the same scheme, and AWS must stay near zero idle cost (0031); a customer KMS key costs about $1 per month per stage.

## Decision
- One `APP_SECRET` of at least 32 characters: a required environment variable on Docker, a generated SecureString SSM parameter `app-secret` on AWS (0033), read by every function.
- HKDF-SHA256 derives a separate 256-bit key per purpose (`totp`, `feed-credentials`, `image-url`, `login-challenge`).
- Stored secrets are AES-256-GCM sealed as `v1.<iv>.<ciphertext>.<tag>`, with the owning row's identity as associated data. Signatures are HMAC-SHA256.
- `node:crypto` only; no KMS.

## Consequences
- No per-stage cost and one code path for both hostings.
- Losing or changing the secret voids 2FA enrolments, feed passwords, and outstanding signed URLs; it must be backed up with the database. Rotation is a future `v2` format, not supported now.
- Anyone with both the database and the secret can read stored secrets.

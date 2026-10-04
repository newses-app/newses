# 0029. Project name and license

- Status: Accepted
- Date: 2026-10-04

## Context
The project needs a product name and a license before it is published. ADR 0009 leaves the license free to choose. It is a self-hosted server that others may run as a hosted service.

## Decision
- The product name stays `rss-reader`; the repository and packages keep their names.
- The project is licensed under AGPL-3.0-or-later (`LICENSE`).

## Consequences
- Anyone who runs a modified version as a network service must offer its users the corresponding source.
- Dependencies must be AGPL-compatible: permissive licenses, MPL-2.0, and (L)GPL-3.0 are fine; GPL-2.0-only is not.

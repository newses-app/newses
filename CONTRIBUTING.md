# Contributing to Newses

Development setup, commands, and code conventions are on the project site: [newses.app/contributing](https://newses.app/contributing/). How Newses is built is in its [architecture](https://newses.app/contributing/architecture), and why in its [decision records](https://newses.app/contributing/adr/).

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as the [security policy](.github/SECURITY.md) describes, never in a public issue.

## Issues

- Issues for Newses (the server, the web, desktop, and Android apps) and its architecture and decision records are tracked here. Problems with the project site's pages and guides go to [`newses-app/newses.app`](https://github.com/newses-app/newses.app/issues).
- Search first, then open a bug report or feature request with its form.
- Open an issue before starting a feature or a large change, so the scope is agreed before the code.

## Pull requests

- Branch from `dev` and target `dev`; `main` is the released state.
- `pnpm check` passes.
- Tests for the change sit next to the code (`*.test.ts`).
- Docs change in the same pull request, in the doc that owns the fact (`AGENTS.md`'s docs map).
- A change to the stack, architecture, data model concepts, API surface, hosting, security model, or a feature's scope comes with an ADR in `docs/adr/`.
- A change to configuration, deployment, or import behaviour comes with a matching pull request in [`newses-app/newses.app`](https://github.com/newses-app/newses.app).
- Link the issue it closes (`Closes #123`).

## License

Newses is licensed under [AGPL-3.0-or-later](LICENSE). Contributions are accepted under the same license; there is no contributor license agreement.

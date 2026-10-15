# Contributing

Thanks for your interest in dbclient. It is a small desktop client for MySQL and DynamoDB built
with Tauri 2 (Rust) and React 19 + TypeScript. This guide covers the setup, the checks a pull
request has to pass, and the rules the code follows. See [docs/architecture.md](docs/architecture.md)
for how the pieces fit together and [docs/ipc-contract.md](docs/ipc-contract.md) for every command.

## Development environment

- [Rust](https://rustup.rs/) stable, with `clippy` and `rustfmt`
- Node.js 22
- [pnpm](https://pnpm.io/) 10.30.2 (pinned in `package.json` through `packageManager`; `corepack enable` picks it up)
- [Docker](https://www.docker.com/) with Compose, for the local databases
- The [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On
  Debian or Ubuntu: `libwebkit2gtk-4.1-dev librsvg2-dev patchelf libdbus-1-dev`.

## Running the app

```sh
pnpm install --frozen-lockfile
pnpm db:up          # MySQL 8.4 on :3307 and DynamoDB Local on :8000
pnpm tauri dev
```

Local MySQL credentials are `dev` / `dev`, database `sample` (root password `root`). DynamoDB
Local accepts any region and access key. `pnpm db:down` stops the containers and removes their data.

## Checks before a pull request

```sh
pnpm format:check   # Prettier
pnpm check          # TypeScript
pnpm test           # Vitest
pnpm lint:rust      # cargo clippy, warnings are errors
pnpm test:rust      # cargo test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

`pnpm verify` runs the first five in order. CI also runs `cargo fmt --check`.

The Rust integration tests in `src-tauri/tests/` skip themselves unless the database variables
are set. To run them against the Docker databases:

```sh
pnpm db:up
DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample \
DBCLIENT_TEST_DYNAMODB_ENDPOINT=http://localhost:8000 \
pnpm test:rust
```

`DBCLIENT_TEST_MYSQL_CA=<path to the server CA PEM>` additionally enables the `verify_ca` TLS test.
CI runs the integration tests against the same containers.

## Code rules

These summarize [AGENTS.md](AGENTS.md), which is the source of truth.

- **Secrets stay in the keyring.** MySQL passwords and AWS secret access keys go to the OS keyring,
  keyed by connection id. After they are saved they never cross IPC again, and they are never part
  of `ConnectionConfig`, logs, or error messages.
- **One IPC error shape.** Every command rejects with `AppError { kind, message }`
  (`src-tauri/src/error.rs`, `src/lib/ipc.ts`). Frontend code branches on `kind`, never on the
  message text. A new command or field must be documented in `docs/ipc-contract.md`.
- **Shortcuts use physical keys.** Match `KeyboardEvent.code` through `src/lib/shortcuts.ts`, never
  `event.key`, so shortcuts keep working with Korean, Japanese or other input sources.
- **Logic lives in tested modules.** Pure logic goes in `src/lib` or a Rust module with unit tests.
  UI components stay thin.
- **Immutable updates.** Stores and reducers return new objects instead of mutating state.
- **Validate at the boundary.** The backend validates every IPC argument and rejects bad input with
  `kind: "invalid_input"`. SQL values are always bound parameters; identifiers are checked against
  the live schema and quoted.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`test:`, `chore:`, `refactor:`, `ci:`. Keep the subject short and in the imperative mood, for
example `fix: keep the stored secret when testing an unchanged connection`.

## Pull requests

- [ ] The change is focused; unrelated refactors go in a separate PR.
- [ ] `pnpm verify` and `cargo fmt --check` pass locally.
- [ ] New logic has unit tests; database behavior has an integration test where practical.
- [ ] `docs/ipc-contract.md` is updated for any command, payload or error change.
- [ ] No credentials, real hostnames or production data in code, tests, fixtures or screenshots.
- [ ] The description says what changed, why, and which checks you actually ran.

## Releases

Pushing a tag `vX.Y.Z` that matches `version` in `src-tauri/tauri.conf.json` runs
`.github/workflows/release.yml`, which builds macOS (Apple silicon and Intel), Windows and Linux
bundles and attaches them to a draft GitHub Release. macOS signing and notarization are used only
when the `APPLE_*` repository secrets are configured; otherwise the bundles are unsigned.

## License of contributions

By submitting a pull request you agree that your contribution is licensed under the
[MIT License](LICENSE) that covers this repository.

## Reporting security issues

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting
from the repository's **Security** tab instead.

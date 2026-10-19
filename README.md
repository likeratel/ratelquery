# dbclient (working title)

A minimal, modern desktop client for MySQL, DynamoDB and Amazon Athena. Tauri 2, React 19 and Rust.

![MySQL result grid with typed cells](docs/screenshots/mysql-grid.png)

## Why another client

Most desktop database tools get four everyday things wrong. This one is built around them.

- **Shortcuts work under any input source.** Every binding is matched on the physical key, so `⌘⏎` runs the statement while a Korean or Japanese keyboard is active instead of typing a stray character.
- **Autocomplete knows your schema.** Table and column names are loaded from `information_schema` the moment you connect, and the editor offers them as you type.
- **Connections heal themselves.** A dropped MySQL session is replaced on the next query. Read statements are retried once; writes are never repeated silently.
- **DynamoDB items are edited as JSON with a diff.** Edit in the DynamoDB wire format or plain JSON, review every added, changed and removed attribute, then save with a condition so you never overwrite something that changed under you.

## Features

**MySQL**

- Query tabs with a CodeMirror editor, schema completion, run all or run the statement at the cursor
- Virtualised result grid with typed cells: integers, decimals and dates keep their exact text, `NULL` is visible, binary is base64
- Edit cells, add and delete rows, then apply them in one transaction guarded to exactly one row per change
- Export the visible rows or the full result as CSV, JSON or SQL inserts
- TLS modes from preferred to full identity verification
- SSH tunnels through a bastion with agent, key file or password auth, and a fingerprint check for unknown host keys

**DynamoDB**

- Browse tables with their key schema and indexes
- Scan and Query with key conditions, filter expressions and paging
- Table and JSON views, item detail, a wire/plain JSON editor and a diff before every save
- Export a scan or query as JSON, JSON Lines or CSV

**Athena**

- The same SQL editor and typed grid, with completion from the Glue Data Catalog
- Only an AWS profile (or access keys) and a region are needed: the workgroup list is loaded for you, and the result location falls back to the workgroup's setting or the console's default bucket (created only when you say so)
- Run, cancel, and see the bytes scanned and engine time for every statement; nothing is ever re-run on its own

**All**

- Secrets live in the OS keyring, never in the settings file
- Export paths are limited to files you chose in the save dialog
- Light and dark themes that follow the system

![Schema completion](docs/screenshots/mysql-autocomplete.png)
![Pending grid edits](docs/screenshots/mysql-pending-edit.png)
![DynamoDB browser](docs/screenshots/dynamo-browser.png)
![Diff review before saving an item](docs/screenshots/dynamo-diff-review.png)

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘N` | New connection |
| `⌘T` | New tab on the current connection |
| `⌘W` | Close tab |
| `⌘⏎` | Run the statement at the cursor, or the DynamoDB form |
| `⇧⌘⏎` | Run the selected text, or everything when nothing is selected |
| `⌘S` | Apply pending grid edits, or review a DynamoDB item |
| `⌘C` / `⇧⌘C` | Copy the focused cell, or the selected rows when several are selected; `⇧` copies rows with a line of column names |
| `⌘B` | Toggle the sidebar |
| `⌘,` | Settings |
| `Esc` | Close the item or cell editor, or a prompt |

`⌘` is `Ctrl` on Windows and Linux.

## Development

Requirements: Rust stable, Node 22, pnpm, Docker.

```sh
pnpm install
pnpm db:up          # MySQL 8.4 on :3307, DynamoDB Local on :8000, SSH bastion on :2222
pnpm tauri dev
```

The seeded MySQL database is `sample` with user `dev` / `dev` (root password `root`). DynamoDB Local accepts any access key, for example `local` / `local`, with the endpoint `http://localhost:8000`.

```sh
pnpm verify         # Prettier, TypeScript, Vitest, clippy and cargo test
```

Live database tests run only when `DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample` and `DBCLIENT_TEST_DYNAMODB_ENDPOINT=http://localhost:8000` are set. An optional `DBCLIENT_TEST_MYSQL_CA=<server ca.pem>` enables the TLS verification test, and `DBCLIENT_TEST_SSH=127.0.0.1:2222` the SSH tunnel tests against the test-only bastion (user `dev` / `dev`, which reaches MySQL as `mysql:3306`).

On macOS, `tauri dev` re-signs the debug binary (see `scripts/cargo.sh`) so the keychain's "Always allow" on saved passwords survives rebuilds. It uses `DBCLIENT_DEV_SIGN_IDENTITY` when set, otherwise the only code-signing identity in your keychain; with none or several it leaves the ad-hoc signature and says so. Set `DBCLIENT_DEV_SIGN=0` to skip signing.

A DynamoDB or Athena connection that uses an AWS profile runs whatever that profile configures, including a `credential_process` command from your AWS config, exactly as the AWS CLI would. There is no local Athena emulator, so Athena is covered by unit tests on the result decoding and the location rules, plus `src-tauri/tests/athena_live.rs`, which runs constant `SELECT`s and metadata statements against a real account only when `DBCLIENT_TEST_ATHENA_PROFILE=<~/.aws profile>` is set (optionally `DBCLIENT_TEST_ATHENA_REGION`, `DBCLIENT_TEST_ATHENA_WORKGROUP`); those statements scan no data, but Athena still writes their result files to the workgroup's result location.

To avoid keychain prompts altogether, choose the file secret store in Settings: secrets are then kept in `<app config dir>/secrets.json` (mode 0600), protected by file permissions only. Secrets are moved when possible; ones the old store refuses to hand over stay there.

See [docs/architecture.md](docs/architecture.md) for the module layout and security model, and [docs/ipc-contract.md](docs/ipc-contract.md) for the commands between the webview and Rust.

## Renaming

The product name lives in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.

## License

MIT

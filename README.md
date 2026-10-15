# dbclient (working title)

A minimal, modern desktop client for MySQL and DynamoDB. Tauri 2, React 19 and Rust.

![MySQL result grid with typed cells](docs/screenshots/mysql-grid.png)

## Why another client

Most desktop database tools get four everyday things wrong. This one is built around them.

- **Shortcuts work under any input source.** Every binding is matched on the physical key, so `⌘⏎` runs the query while a Korean or Japanese keyboard is active instead of typing a stray character.
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

**DynamoDB**

- Browse tables with their key schema and indexes
- Scan and Query with key conditions, filter expressions and paging
- Table and JSON views, item detail, a wire/plain JSON editor and a diff before every save
- Export a scan or query as JSON, JSON Lines or CSV

**Both**

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
| `⌘⏎` | Run the query, or the DynamoDB form |
| `⇧⌘⏎` | Run the statement at the cursor |
| `⌘S` | Apply pending grid edits, or review a DynamoDB item |
| `⌘C` / `⇧⌘C` | Copy the selected cell or row |
| `⌘B` | Toggle the sidebar |

`⌘` is `Ctrl` on Windows and Linux.

## Development

Requirements: Rust stable, Node 22, pnpm, Docker.

```sh
pnpm install
pnpm db:up          # MySQL 8.4 on :3307 and DynamoDB Local on :8000
pnpm tauri dev
```

The seeded MySQL database is `sample` with user `dev` / `dev` (root password `root`). DynamoDB Local accepts any access key, for example `local` / `local`, with the endpoint `http://localhost:8000`.

```sh
pnpm verify         # Prettier, TypeScript, Vitest, clippy and cargo test
```

Live database tests run only when `DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample` and `DBCLIENT_TEST_DYNAMODB_ENDPOINT=http://localhost:8000` are set. An optional `DBCLIENT_TEST_MYSQL_CA=<server ca.pem>` enables the TLS verification test.

On macOS, a development build is ad-hoc signed, so the keychain asks before the app may read a saved password after each rebuild. Signed release builds ask once.

See [docs/architecture.md](docs/architecture.md) for the module layout and security model, and [docs/ipc-contract.md](docs/ipc-contract.md) for the commands between the webview and Rust.

## Renaming

The product name lives in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `src/appMeta.ts`.

## License

MIT

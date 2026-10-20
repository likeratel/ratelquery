# Architecture

ratelquery is a Tauri 2 application. A React 19 + TypeScript webview renders the UI, and a Rust
backend owns every database connection, credential and file write. The two sides talk only through
Tauri commands and events, documented in [ipc-contract.md](ipc-contract.md).

## Module structure

### Frontend (`src/`)

| Directory | Contents |
| --- | --- |
| `features/` | One folder per screen: `connections/` (connection list and dialog), `query/` (MySQL editor, results grid, edits and export), `dynamo/` (table browser, query form, item editor). Athena has no screen of its own: the connection dialog gains its fields, the schema tree its catalog branch (`schema/athenaActions.ts`) and the query tab its start/wait/cancel path. Components here stay thin and call into `lib/` and `state/`. |
| `lib/` | Pure, unit-tested helpers: the typed IPC wrapper (`ipc.ts`), MySQL, DynamoDB and Athena types, cell formatting, grid edits, DynamoDB JSON conversion and diffing, SQL context for autocomplete, and physical-key shortcut matching (`shortcuts.ts`). |
| `state/` | zustand stores: `connectionsStore` (saved configs, dialog state), `sessionsStore` (per-connection session state and schema cache), `tabsStore` (open tabs grouped by connection with the last active tab of each, SQL text, last result), `athenaStore` (per-connection Glue catalog cache), `uiStore`. Updates are immutable. |
| `components/` | Shared UI: the shell (sidebar, two-row tab bar with connection tabs above the active connection's tabs, the connection banner above every tab, editor bar), CodeMirror SQL and JSON editors, the virtualized result grid, and small UI primitives. |

### Backend (`src-tauri/src/`)

| Module | Contents |
| --- | --- |
| `commands/` | Tauri command handlers grouped by area (`connections`, `mysql`, `dynamo`, `athena`, `export`, `system`). They translate IPC arguments into calls on the modules below. |
| `connections/` | Connection model and validation, the JSON config store, the secret stores (OS keyring or `secrets.json`, switched by settings, with secret migration on a switch), and connection probes for `connections_test`. |
| `mysql/` | Per-connection `sqlx` pools and their registry, the statement splitter, read-statement classification for retries, cell decoding, schema snapshots, transactional grid edits, and streaming export. |
| `dynamo/` | Per-connection AWS SDK clients and their registry, wire-format items, key and filter expressions, query/scan/get/put/delete, and export. |
| `athena/` | Per-connection Athena clients with the resolved result location, Glue catalog listing as `SchemaSnapshot`, start/wait/cancel of query executions with paged result reading, and the text-to-`Cell` decoding by column type. |
| `export/` | CSV, JSON and SQL formatters, and the safe file writer used by every export. |
| `error.rs` | `AppError`, the single error type serialized to the webview as `{ kind, message }`. |
| `legacy_config.rs` | One-time copy at startup from the config dir of the app's former identifier `dev.harry.dbclient`: when the new config dir has no `connections.json`, `connections.json`, `settings.json`, `secrets.json` and `known_hosts` are copied (never moved, owner-only, existing files kept; failures are logged to stderr). Keychain entries under the former service `dbclient` are not migrated. |
| `util.rs` | Shared helpers: `run_blocking` (keyring and file I/O from commands and exports runs on the blocking pool, never on an async worker) and `elapsed_ms`. |

## Data flow

```text
React component
  -> lib/ipc.ts invoke("mysql_query", { connectionId, sql, options })
  -> Tauri IPC
  -> commands/mysql.rs
  -> mysql/ session registry -> sqlx pool -> MySQL server
  <- QueryResult[] (tagged cells) or AppError { kind, message }
  <- store update (immutable) -> re-render
```

DynamoDB follows the same path through `commands/dynamo.rs` and the AWS SDK, with items kept in
the DynamoDB JSON wire format so no type is lost. Cell values from MySQL are tagged (`int`,
`decimal`, `bytes`, ...) so `BIGINT` and `DECIMAL` values never lose precision in JavaScript.

`lib/ipc.ts` normalizes every rejection into an `AppError`; any unrecognized shape becomes
`kind: "unknown"`. The backend pushes MySQL session state to the webview through the
`mysql:state` event, which `sessionsStore` subscribes to.

## Security model

- **Credentials.** MySQL passwords and AWS secret access keys are passed only as the `secret`
  argument of `connections_save` and `connections_test`, then stored in the OS keyring under
  service `ratelquery`, account `<connection id>` (or in the owner-only `secrets.json` when the
  file store is chosen in Settings). They are never part of the saved config or any command
  result, and a stored secret is never reused for a config that points at another server.
  Connection configs are written atomically to `<app config dir>/connections.json` with
  owner-only permissions (`0600` on unix).
- **Export paths.** The webview has no filesystem permission. The fs plugin is loaded only for
  its runtime scope: when the user picks a file in the save dialog, the dialog plugin adds that
  file to the scope, and the export commands refuse any path not in it (`invalid_input`). Files
  are written to an owner-only temp file next to the target and renamed into place, so a failed
  export leaves nothing behind.
- **Content Security Policy.** `tauri.conf.json` restricts scripts, fonts and images to the app
  itself and allows `connect-src` only to the Tauri IPC endpoints, so the webview cannot open
  network connections of its own; all database traffic goes through Rust.
- **Capabilities.** The main window gets `core:default`, `dialog:allow-save` and
  `core:window:allow-start-dragging` only (`src-tauri/capabilities/default.json`).
- **Input validation.** Every command validates its arguments in Rust. Grid edits check the
  database, table and column names against the live schema, quote identifiers and bind all values.

## Automatic reconnection

Each MySQL connection has one `sqlx` pool (up to 4 connections, connections tested before
use, 10 s acquire timeout). Connection-level failures are recognized by error type and MySQL
error number (2006, 2013, 4031), never by message text.

- A failure **before** a statement is sent (acquiring a connection or replaying `USE`) is
  retried once on a fresh connection.
- A failure **while** a statement runs is retried once only for read-only statements (`SELECT`,
  `SHOW`, `EXPLAIN`, `WITH`, ... without data-modifying clauses). Writes are never re-run; the
  error says the statement may or may not have been applied.
- Results that recovered carry `reconnected: true`, which the UI shows next to the result.
- An acquire timeout while every pooled connection runs a query is reported as busy
  (`connection`, no retry, no state change), not as a lost connection.
- Session state (`connecting`, `connected`, `reconnecting`, `disconnected`, `error`) is pushed
  through `mysql:state`; the session registry is its only owner, so reconnecting an open id
  closes the old session first and a failed connect leaves no session behind. A background
  task pings an idle connection of each pool every 30 s (skipped while all are busy), and any
  successful round trip after `error` or `reconnecting` reports `connected` again.

DynamoDB has no long-lived session. A client is built per connection on first use, its
credentials are resolved once and cached, and missing or expired credentials surface as
`kind: "credential"` with the command to fix them (for example `aws sso login`).

Athena is asynchronous on the AWS side: `athena_start` submits one statement and returns its
execution id, `athena_wait` polls it to a terminal state and reads the result pages, and
`athena_cancel` stops it. The query tab keeps the id while a statement runs so Cancel works. Every
statement is billed by bytes scanned, so nothing is retried; the result location is resolved
once per client (workgroup setting, then the connection's, then the console's default bucket,
which is only created after an explicit confirmation in the connection dialog).

## Known limitations

From [ipc-contract.md](ipc-contract.md):

- **Athena** results are read through `GetQueryResults` (text values typed by column), so very
  large results are capped by the row limit rather than streamed, and `varbinary` is decoded
  from Athena's hex text. Multi-statement scripts run one statement at a time; a failure stops
  the rest. The editor's keyword list is PostgreSQL's (closest to Trino in lang-sql), and `#`
  comments and backslash escapes in strings still follow MySQL rules when a script is split.

- **TLS `verify_ca`** currently also checks the host name (with sqlx 0.8.6 and rustls 0.23.46), so
  it behaves like `verify_identity` and fails closed.
- **CSV formula injection.** CSV cells are written verbatim, so values starting with `=`, `+`, `-`
  or `@` may be treated as formulas by spreadsheet applications.
- **Binary-flagged strings.** sqlx does not expose the collation, so text in a `_bin` collation
  and real binary columns are told apart from `information_schema` for single-table reads (an
  alias reusing another column's name can be misattributed) and from the values otherwise.
- **Read-statement retry.** `is_read_statement` looks at the statement text only, so a `SELECT`
  calling a stored function with side effects is still retried once after a connection loss.
- **`NO_BACKSLASH_ESCAPES`.** The splitter, the read-statement check and the SQL export treat
  `\` in strings as an escape; sessions using that `sql_mode` are not supported.

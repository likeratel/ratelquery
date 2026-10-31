<img src="docs/ratelquery.png" alt="ratelquery, a honey badger looking straight at you" width="128" />

# ratelquery

A minimal, modern desktop client for MySQL, DynamoDB and Amazon Athena. Tauri 2, React 19 and Rust. Named after the ratel (honey badger): it digs into any table and is not put off by a few stings.

> Built with AI. I set the direction and tested every feature against my own databases; the code, tests and docs were written in sessions with [Claude Code](https://claude.com/claude-code). See [Why I built this](#why-i-built-this).

![Tabs grouped by connection above a MySQL result grid](docs/screenshots/mysql-grid.png)

## Install

Download the latest build from [Releases](https://github.com/likeratel/ratelquery/releases/latest):

| Platform             | File                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| macOS, Apple silicon | `ratelquery_<version>_aarch64.dmg`                                           |
| macOS, Intel         | `ratelquery_<version>_x64.dmg`                                               |
| Windows              | `ratelquery_<version>_x64-setup.exe` or `ratelquery_<version>_x64_en-US.msi` |
| Linux                | `ratelquery_<version>_amd64.AppImage`, `.deb` or `.rpm`                      |

On macOS, open the `.dmg` and drag **ratelquery** into Applications. Builds are not notarized by Apple, so the first launch is blocked with "ratelquery can't be opened" or "is damaged". Either right-click the app in Applications and choose **Open**, or clear the download flag once:

```sh
xattr -dr com.apple.quarantine /Applications/ratelquery.app
```

On Windows, SmartScreen may warn about an unknown publisher: choose **More info → Run anyway**. On Linux, install the `.deb` or `.rpm`, or make the AppImage executable (`chmod +x`) and run it.

To update, quit the app and replace it with the new version. Connections, folders, settings and saved passwords are kept: they live in the app's config folder (`~/Library/Application Support/dev.harry.ratelquery` on macOS), not in the app bundle.

To build it yourself instead, see [Development](#development).

## Why another client

Most desktop database tools get four everyday things wrong. This one is built around them.

- **Shortcuts work under any input source.** Every binding is matched on the physical key, so `⌘⏎` runs the statement while a Korean or Japanese keyboard is active instead of typing a stray character.
- **Autocomplete knows your schema.** Table and column names are loaded from `information_schema` the moment you connect, and the editor offers them as you type.
- **Connections heal themselves.** A dropped MySQL session is replaced on the next query. Read statements are retried once; writes are never repeated silently.
- **DynamoDB items are edited as JSON with a diff.** Edit in the DynamoDB wire format or plain JSON, review every added, changed and removed attribute, then save with a condition so you never overwrite something that changed under you.

## Why I built this

I use MySQL, DynamoDB and Athena every day, and the clients I had kept getting in the way. Under a Korean input source, `⌘⏎` in MySQL Workbench and DBeaver typed a character instead of running the query. Autocomplete rarely knew my schema. A connection that went idle over lunch had to be reconnected by hand. And the interfaces felt like they were designed for a different decade. I wanted one small app that got those things right, looked calm, and still had the power features I reach for: typed result grids, cell editing with a transaction, DynamoDB item editing with a diff, SSH tunnels, and Athena with the catalog in the sidebar.

What I did: decided what to build and what to leave out, picked the stack (Tauri 2, React 19, Rust) and the safety rules (default `LIMIT`, confirmation before destructive statements, nothing re-run on Athena because scans cost money), ran every stage against real MySQL, DynamoDB and Athena, and sent each change through an independent review round before it was committed. The implementation, the 800-plus tests and these docs were written with Claude Code. The honey badger artwork was generated from prompts and composed into the icons by hand.

## Features

**MySQL**

- Query tabs with a CodeMirror editor, schema completion, run all or run the statement at the cursor
- Virtualised result grid with typed cells: integers, decimals and dates keep their exact text, `NULL` is visible, binary is base64
- Edit cells, add and delete rows, then apply them in one transaction guarded to exactly one row per change. Works on single-table results that include the primary key, in any letter case and with `db.table` names
- Export the visible rows or the full result as CSV, JSON or SQL inserts
- TLS modes from preferred to full identity verification
- SSH tunnels through a bastion with agent, key file or password auth, and a fingerprint check for unknown host keys

**DynamoDB**

- Browse tables with their key schema and indexes
- Scan and Query with key conditions, filter expressions and paging
- Table and JSON views, an item panel with a Tree and a JSON view, a wire/plain JSON editor and a diff before every save
- Edit string, number and boolean values right in the grid or anywhere in the item tree, including inside JSON stored in a string, then apply them together; each write only succeeds if the item still holds the values you started from
- Export a scan or query as JSON, JSON Lines or CSV

**Athena**

- The same SQL editor and typed grid, with completion from the Glue Data Catalog
- Only an AWS profile (or access keys) and a region are needed: the workgroup list is loaded for you, and the result location falls back to the workgroup's setting or the console's default bucket (created only when you say so)
- Run, cancel, and see the bytes scanned and engine time for every statement; nothing is ever re-run on its own

**All**

- Tabs are grouped under their connection, and a coloured strip above every tab names the server and database it talks to, so a statement never goes to the wrong place
- Nested folders and your own order for connections; duplicate a connection with its saved password
- An Output log next to the results with every statement's outcome, kept for the number of days you choose
- Resizable sidebar and DynamoDB panels
- Secrets live in the OS keyring, never in the settings file
- Export paths are limited to files you chose in the save dialog
- Light and dark themes that follow the system

## Using ratelquery

### Connections

Press `⌘N` (or **+** in the sidebar) and pick MySQL, DynamoDB or Athena. **Test** checks the settings before you save. Give production connections a colour: it follows the connection into its tabs and the strip above the editor.

- **MySQL**: host, port, user, password and an optional default database. TLS and an SSH tunnel (agent, key file or password) are under the same dialog.
- **DynamoDB**: a region and either an AWS profile from `~/.aws` or access keys. Set an endpoint such as `http://localhost:8000` for DynamoDB Local.
- **Athena**: a region and an AWS profile or keys. Workgroups are listed for you; the result location comes from the workgroup unless you set one.

Organise the sidebar with **New folder** (next to **+**). Folders nest up to 32 levels deep: pick **New subfolder** in a folder's **…** menu, or drag a folder onto another one. Drag connections and folders to reorder them or drop them on a folder. The **…** menu on a row has the same moves (**Move up**, **Move down**, **Move to folder…**, which names each folder by its full path) plus **Edit**, **Duplicate** and **Delete**. Duplicate copies the saved password too. Deleting a folder keeps what it holds: its connections and subfolders move up a level.

Passwords go to the macOS keychain (or the Windows credential store). If the keychain keeps asking after an update, choose the file store in Settings, which keeps them in a `0600` file in the config folder.

### Tabs

Click a connection to open a tab on it. The top row has one tab per connection with open tabs; the row below shows that connection's query, table and DynamoDB tabs. The strip under the tabs repeats the connection, its host and the database a query will run in.

`⌘1`…`⌘8` switch between the tabs of the current connection and `⌘9` jumps to its last tab. Add `⌥` to switch connections instead. The tabs you had open come back when you restart the app.

### Running SQL

`⌘⏎` runs the statement at the cursor, `⇧⌘⏎` runs the selection or the whole editor. Pick the database next to **Run**. A `SELECT` without a `LIMIT` gets the default limit from Settings, and `UPDATE` or `DELETE` without a `WHERE`, `DROP`, `TRUNCATE`, `ALTER` and `RENAME TABLE` ask first.

![Schema completion](docs/screenshots/mysql-autocomplete.png)

The bottom panel has two tabs. **Results** shows the rows, one sub-tab per statement when several ran. **Output** logs what the database answered for each statement: rows returned, rows affected or the error, with the time it took. A red dot on **Output** means an error you haven't looked at yet. Click a statement to see all of it; the buttons on each entry put its SQL back in the editor or copy it. Output is kept for 30 days by default; change it under **Settings → Keep query output for (days)**, where 0 keeps nothing on disk.

![Output log of a script](docs/screenshots/mysql-output.png)

### Editing MySQL rows

Results from a single table that include its primary key can be edited. Double-click a cell or press `Enter` to edit it, type `NULL` for SQL `NULL`, and use **Add row** and **Delete row** in the toolbar. Changes stay pending, marked in the grid, until you press **Apply** (`⌘S`); they are then written in one transaction, and the whole batch is rolled back if any change does not hit exactly one row. Joins, aggregates, computed columns, views and tables without a primary key stay read only, and the toolbar says why.

![Pending grid edits](docs/screenshots/mysql-pending-edit.png)

### DynamoDB

Choose a table on the left, then **Scan** or **Query** (with a key condition, filter, names and values) and press `⌘⏎`. Click an item to see it on the right; drag the panel edges to resize them.

![DynamoDB browser](docs/screenshots/dynamo-browser.png)

String, number and boolean cells can be edited right in the grid; keys, `NULL`, maps, lists, sets and binary open the item editor instead. Grid edits wait for **Apply**, and each item is written only if it still has the values you loaded, so a change made elsewhere in the meantime is refused rather than overwritten.

![DynamoDB grid edits waiting for Apply](docs/screenshots/dynamo-inline-edit.png)

The item panel has two views. **Tree** shows every attribute, keys first, with its type; maps, lists and sets open to any depth, and a closed node shows its size (`M · 16 keys`, `L · 2 items`). It opens the first level by default, **Expand all** and **Collapse all** do the rest, and what you open stays open as you move to other items of the table. Each row can copy its path (`senderService.numbers[0].senderNumber`) or its value. A list of two or more maps that share keys can be shown as a table, with the union of their keys as columns; click a nested cell to follow it into the tree. A string that holds a JSON object or array gets a **JSON** badge and opens like a map. **JSON** shows the item read-only with highlighting and folding, in plain JSON or the wire format, the same mode **Edit** opens in.

Double-click a string, number or boolean in the tree (or press Enter on it) to edit it in place, at any depth. Keys stay read-only and numbers are checked like in the grid. Inside JSON stored in a string, values can be edited only when the string is compact JSON that `JSON.stringify` gives back unchanged; otherwise the badge says why (not compact, or numbers beyond 2^53), so nothing is reformatted or rounded. Tree and grid edits of an item are the same pending changes: **Apply** (`⌘S` in the panel) lists them, then writes them with one `UpdateItem` that sets each nested path only if it, and every list on the way to it, still holds what you loaded. A list that shifted in the meantime refuses the write rather than changing another element. If a refresh shows the item changed under a pending edit, the edit is marked as a conflict instead of being laid over the new values. **Discard** drops them.

**Find** (`⌘F` anywhere in a DynamoDB tab while an item is open) searches the tree: attribute names, map keys and values at every depth, set members, and the inside of JSON stored in a string. It ignores case unless **Aa** is on, and **Keys** and **Values** pick what is searched. Values match on the text the tree shows: numbers on their exact text, booleans as `true` and `false`, and `NULL` (DynamoDB's or JSON's) as `NULL`, so `null` finds it unless **Aa** is on; binary values are not searched. A long value shows its first 400 characters, and a `+N` after it counts the matches past them.

Text that reads as a path, written the way **Copy path** writes it (`numbers[0].senderStatus`, `senderService.numbers[1]`, `["odd key"]`), jumps to that row from the top, or else to every row whose path ends with it; a path that leads nowhere is searched as text. When a path jump hides text matches of the same query, the bar offers **N as text**, which wraps the query in double quotes: a quoted query is always searched as text.

By default matches are highlighted in the whole tree, the rows above them open, and `⏎` / `⇧⏎` (or the arrows) step through them with a `3 / 12` count, left to right through the cells of a list shown as a table. Past 500 matches only the current match's rows are opened, so a short query on a large item doesn't open all of it. The filter button instead shows only the matching rows and the rows above them, keeping pending changes and an open field in view; a table keeps only the rows that hold a match. Matching runs on the values shown, pending edits included, and they stay editable. Opening and closing nodes, **Expand all**, **Collapse all** (which keeps the current match open) and table toggles during a search last until it is cleared, and the tree then returns to the way you left it. The filter, **Aa**, **Keys** and **Values** choices are kept for the tab, and the query for the table while you move between items. `⎋` clears the query, then closes the bar. Switching to **JSON** carries the query into the editor's search (a path the tree jumped to as its last key), which opens folded regions to show a match. `⌘F` inside a JSON editor is the editor's own search; in other text fields it does nothing, and with no item open it goes to **Filter tables**.

**Edit item** opens the JSON editor, in plain JSON or the DynamoDB wire format, for structural changes such as adding or removing attributes. Pending tree or grid changes of the item move into the editor's text, so its review lists them and saving writes everything at once, still only while the values they started from hold; discarding the editor drops them. Changes that already failed or conflict with the item stay in the panel until you discard them. `⌘S` shows every added, changed and removed attribute before anything is saved.

![Diff review before saving an item](docs/screenshots/dynamo-diff-review.png)

### Athena

Athena tabs use the same editor, with tables and columns from the Glue Data Catalog in the sidebar and in completion. Every statement shows the data it scanned and its engine time. Queries are never re-run on their own, because each run is billed.

### Exporting

**Export** above a grid saves the visible rows or the full result as CSV, JSON or SQL inserts; DynamoDB exports a scan or query as JSON, JSON Lines or CSV. **Copy** puts cells or rows on the clipboard.

## Shortcuts

| Shortcut            | Action                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `⌘N`                | New connection                                                                                                                              |
| `⌘T`                | New tab on the current connection                                                                                                           |
| `⌘W`                | Close tab                                                                                                                                   |
| `⌘1`…`⌘8` / `⌘9`    | Go to that tab of the current connection / its last tab                                                                                     |
| `⌥⌘1`…`⌥⌘8` / `⌥⌘9` | Go to that connection (its last used tab) / the last connection                                                                             |
| `⌘⏎`                | Run the statement at the cursor, or the DynamoDB form                                                                                       |
| `⇧⌘⏎`               | Run the selected text, or everything when nothing is selected                                                                               |
| `⌘S`                | Apply pending grid edits, or review a DynamoDB item (in the item panel: review, then apply its changes)                                     |
| `⌘F`                | Find in the DynamoDB item panel (selects the query when already there); search inside a JSON editor; **Filter tables** when no item is open |
| `⏎` / `⇧⏎`          | Next / previous match in the item find bar; `⎋` clears it, then closes it                                                                   |
| `⌘C` / `⇧⌘C`        | Copy the focused cell, or the selected rows when several are selected; `⇧` copies rows with a line of column names                          |
| `⌘B`                | Toggle the sidebar                                                                                                                          |
| `⌘,`                | Settings                                                                                                                                    |
| `Esc`               | Close the item or cell editor, or a prompt                                                                                                  |

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

Live database tests run only when `RATELQUERY_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample` and `RATELQUERY_TEST_DYNAMODB_ENDPOINT=http://localhost:8000` are set. An optional `RATELQUERY_TEST_MYSQL_CA=<server ca.pem>` enables the TLS verification test, and `RATELQUERY_TEST_SSH=127.0.0.1:2222` the SSH tunnel tests against the test-only bastion (user `dev` / `dev`, which reaches MySQL as `mysql:3306`).

On macOS, `tauri dev` re-signs the debug binary (see `scripts/cargo.sh`) so the keychain's "Always allow" on saved passwords survives rebuilds. It uses `RATELQUERY_DEV_SIGN_IDENTITY` when set, otherwise the only code-signing identity in your keychain; with none or several it leaves the ad-hoc signature and says so. Set `RATELQUERY_DEV_SIGN=0` to skip signing.

A DynamoDB or Athena connection that uses an AWS profile runs whatever that profile configures, including a `credential_process` command from your AWS config, exactly as the AWS CLI would. There is no local Athena emulator, so Athena is covered by unit tests on the result decoding and the location rules, plus `src-tauri/tests/athena_live.rs`, which runs constant `SELECT`s and metadata statements against a real account only when `RATELQUERY_TEST_ATHENA_PROFILE=<~/.aws profile>` is set (optionally `RATELQUERY_TEST_ATHENA_REGION`, `RATELQUERY_TEST_ATHENA_WORKGROUP`); those statements scan no data, but Athena still writes their result files to the workgroup's result location.

To avoid keychain prompts altogether, choose the file secret store in Settings: secrets are then kept in `<app config dir>/secrets.json` (mode 0600), protected by file permissions only. Secrets are moved when possible; ones the old store refuses to hand over stay there.

See [docs/architecture.md](docs/architecture.md) for the module layout and security model, and [docs/ipc-contract.md](docs/ipc-contract.md) for the commands between the webview and Rust.

## License

MIT

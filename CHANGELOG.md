# Changelog

Notable changes to ratelquery, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). The section for a version becomes the body of its
GitHub Release (see [Releases](CONTRIBUTING.md#releases)).

## [Unreleased]

## [0.5.0] - 2026-11-23

### Added

- **Hover for schema details.** Rest the pointer on a name in the SQL editor to see what it is: a
  column's type, `NULL` / `NOT NULL`, primary key, auto increment, default and comment; a table's
  or view's columns; a database's table count. Qualified names (`db.table.column`, `alias.column`)
  and aliases resolve like completion, and a column found in more than one joined table shows each.
- **ENUM and SET values in completion.** After `status =`, `!=`, `<>`, `<=>` or inside
  `status IN (...)`, completion offers the column's members as string literals, in declared order.
  Inside a quote (`status = '|'`) it offers the bare members and closes the quote for you.
- **Whole-window zoom.** `⌘=` / `⌘-` / `⌘0` zoom the entire window from 80% to 175%, also in
  Settings → Appearance (#5).
- **Reveal the active tab in the Connections tree** with `⌘⇧E`: the sidebar expands down to the
  tab's database or table and focuses it. Settings → Sidebar can do this on every tab switch (#7).

### Changed

- The sidebar toggle sits at the top left, beside the window controls (#5).

### Fixed

- `USE db` in a query tab now moves the tab's Database picker, and rows read after a `USE` are
  edited in that database (#6).

## [0.4.0] - 2026-11-17

### Added

- **Trash for deleted MySQL rows.** Rows deleted from the grid, or by a single-table `DELETE` run
  from the editor, are saved to a Trash on this computer before they are deleted, and can be
  restored (to the original or another connection) or deleted for good. Entries are removed after
  30 days by default.
- The app asks before a delete that can't be backed up: multi-table `DELETE`, functions with side
  effects, transaction statements in the script, MyISAM tables, more than 10,000 rows.
- Applying grid edits that update or delete rows shows the exact statements first.
- Delete row works on every checked row and is always available on editable results.
- `⇧⌘W` closes every tab of the current connection.

### Security

- Updated `russh` for RUSTSEC-2026-0495.

## [0.3.0] - 2026-11-03

### Added

- DynamoDB items open in a Tree and a JSON view with find, and nested values (including JSON
  stored in a string) can be edited in place, guarded by the values you loaded (#2).

### Fixed

- Connection layouts nested deeper than `serde_json`'s default limit load again (#4).
- The `Esc` that ends an IME composition no longer closes the DynamoDB item editor.

### Security

- Updated crates with RustSec advisories (#3).

## [0.2.1] - 2026-11-03

### Added

- Folders inside folders in the connection sidebar (#1).

### Fixed

- Athena results show in both Results and Output.

## [0.2.0] - 2026-10-20

### Added

- Amazon Athena connections: catalog in the sidebar, completion from the Glue Data Catalog, bytes
  scanned and engine time per statement.
- Tabs grouped by connection, with a strip naming the server and database each query runs in.
- Chrome-style shortcuts: `⌘1`–`⌘8` switch tabs, `⌘9` jumps to the last one, and with `⌥` they
  switch connections.
- Results and an Output log of every statement, kept for 30 days by default.
- Connection folders, manual ordering, and duplicating a connection with its saved secrets.
- DynamoDB grid editing for string, number and boolean cells, applied together.
- Resizable sidebar and DynamoDB panels.
- Row selection and copy options in the result grid.
- The query tabs open at quit are restored on launch.

### Fixed

- MySQL results no longer show as read only in reopened tabs, with `ORDER BY a, b DESC`, with
  names in a different letter case or with `db.table` names.

[Unreleased]: https://github.com/likeratel/ratelquery/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/likeratel/ratelquery/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/likeratel/ratelquery/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/likeratel/ratelquery/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/likeratel/ratelquery/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/likeratel/ratelquery/releases/tag/v0.2.0

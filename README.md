# dbclient (working title)

A minimal, modern desktop client for MySQL and DynamoDB, built with Tauri 2, React and Rust.

Why another client:

- Shortcuts are matched on the physical key, so `⌘⏎` keeps working while a Korean or Japanese input source is active.
- Schema-aware SQL autocomplete out of the box.
- Connections heal themselves. A dropped MySQL session reconnects on the next query instead of freezing the app.
- DynamoDB items are edited as JSON with a diff before every write.

## Development

```sh
pnpm install
pnpm db:up          # MySQL 8.4 on :3307 and DynamoDB Local on :8000 via Docker
pnpm tauri dev
```

Local MySQL credentials: `dev` / `dev`, database `sample` (root password `root`).

```sh
pnpm check          # TypeScript
pnpm test           # Vitest
pnpm format:check   # Prettier
cargo test --manifest-path src-tauri/Cargo.toml
```

Live database tests are skipped unless `DBCLIENT_TEST_MYSQL_URL=mysql://dev:dev@127.0.0.1:3307/sample` and `DBCLIENT_TEST_DYNAMODB_ENDPOINT=http://localhost:8000` are set (optional: `DBCLIENT_TEST_MYSQL_CA=<server ca.pem>`).

## Renaming

The product name lives in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `src/appMeta.ts`.

## License

MIT

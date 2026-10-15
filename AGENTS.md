# Agent guide

Desktop DB client for MySQL and DynamoDB. Tauri 2 (Rust) backend, React 19 + TypeScript frontend.

## Layout

- `src/` frontend. `lib/` pure helpers with tests, `state/` zustand stores, `components/` UI, `features/` per-database screens.
- `src-tauri/src/` backend. `commands/` Tauri commands grouped by area, `error.rs` the single IPC error type.
- `docker/` local MySQL and DynamoDB Local with seed data.

## Rules

- Credentials never cross IPC in plain form after being stored. Secrets live in the OS keyring by default, or in the app's 0600 `secrets.json` when the user picks file storage in Settings, keyed by connection id.
- Every IPC error is `{ kind, message }` (`AppError`). Frontend code branches on `kind`, never on message text.
- Shortcuts match `KeyboardEvent.code` through `src/lib/shortcuts.ts`, never `event.key`.
- Pure logic goes in `src/lib` or Rust modules with unit tests. UI components stay thin.
- Immutable updates only in stores and reducers.

## Verify

```sh
pnpm check && pnpm test && pnpm format:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Integration tests that need databases use `pnpm db:up` first.

## Commits

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

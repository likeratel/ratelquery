## Summary

<!-- What changed and why. Link the related issue, if any. -->

## Verification

<!-- List the checks you actually ran and their result. Do not list checks you did not run. -->

- [ ] `pnpm verify`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- [ ] Integration tests against `pnpm db:up` (if database behavior changed)
- [ ] Manual check in `pnpm tauri dev` (if UI changed)

## Checklist

- [ ] Commits follow Conventional Commits.
- [ ] `docs/ipc-contract.md` is updated for command, payload or error changes.
- [ ] No credentials, real hostnames or production data are included.

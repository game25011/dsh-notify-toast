## Summary

<!-- A short description of what this pull request does and why. -->

## Changes

<!-- List the user-visible and internal changes. Keep the list focused. -->

-
## Tests run

<!-- Check every command you ran. Paste failures or relevant output below if needed. -->

- [ ] `npm test` — 68 unit tests
- [ ] `npm run smoke` — 23 client smoke tests
- [ ] `node scripts/probe-rpc.mjs --self-check` — 7 checks
- [ ] `node scripts/host-probe.mjs <profileDir>` — Host-side changes only
- [ ] Manual check on Windows 10/11: toast appears, sound plays, click returns to DSH
- [ ] `npm pack` / `npm pack --dry-run` — when the published file set changes

## Docs and locale

- [ ] `README.md` and `README.en.md` updated for user-facing changes
- [ ] `CHANGELOG.md` updated under the unreleased section
- [ ] `locale/zh.json` and `locale/en.json` kept in sync
- [ ] Embedded Chinese/English dictionaries in `lib/client.js` kept in sync

## Checklist

- [ ] The change is focused and contains no unrelated refactoring
- [ ] No new runtime dependencies were added
- [ ] No build artifacts, logs, secrets, tokens, cookies, personal data, or local absolute paths are included
- [ ] Windows-specific code degrades without crashing, and the RPC route stays fail-closed
- [ ] I agree that my contribution is licensed under the MIT License (see `LICENSE`)

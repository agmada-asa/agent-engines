# Compatibility checks

## Codex

- `src/codex/protocol/` is generated from the Codex CLI pinned in `src/codex/protocol/version.ts`.
- Codex at or above the pinned version, within the same major, is accepted. Real drift fails where it happens.
- The bindings are generated with Codex's experimental API (plan mode, background terminals and realtime need it), and the client opts in to it on `initialize`.

To move to a newer Codex: install it, bump `CODEX_PROTOCOL_VERSION`, run `npm run generate:protocol` and review the diff.

## Claude

Claude Code has a minimum version (`CLAUDE_CODE_MIN_VERSION`) and no ceiling.

## Checking your install

`npm run check:runtimes` checks the installed Codex and Claude Code: versions, every app-server method and enum value the engines use (`CODEX_PROTOCOL_CONTRACT`), sign-in, and each model catalogue. It starts no model turn.

Passing `--expect models.json` fails on catalogue drift.

CI runs the check weekly against the latest CLIs.

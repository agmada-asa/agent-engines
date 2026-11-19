/**
 * @file Records the Codex CLI version the checked-in protocol bindings were generated from.
 * `npm run generate:protocol` refuses to run with any other installed version, and
 * `codexVersionIncompatibility` in `src/versions.ts` treats it as the oldest Codex accepted.
 */

/** Codex CLI/app-server version used to generate the checked-in bindings; the oldest accepted. */
export const CODEX_PROTOCOL_VERSION = "0.164.0";

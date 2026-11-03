# Versions and updates

`engine.runtimeVersion()` says what's installed and what's published, without starting a turn or an app-server. `engine.updateRuntime()` moves it.

When to check, whether to ask and when to restart are your app's to decide.

```ts
const status = await engine.runtimeVersion();
// { version: "0.164.0", latest: "0.166.0", managedBy: "npm", updateOffered: true, ... }

if (status.updateOffered) {
  try {
    const { from, to } = await engine.updateRuntime();
    // Later, to go back, if the owner can pin: await engine.updateRuntime({ version: from });
  } catch (error) {
    if (error instanceof RuntimeUpdateError) show(error.reason, error.message, error.output);
  }
}
```

## What an update reaches

Running threads keep the process they have.

- **Claude:** an update reaches new threads, and any prewarmed ones are closed.
- **Codex:** threads share one app-server per engine, so new threads stay on the old version too until the app makes a new engine (`close()` is final).

## Who owns the install

`managedBy` comes from where the binary really lives: `npm`, `pnpm` or `bun` for a global install, `homebrew` for a cask, `self` for Claude Code's native installer or Codex's standalone one, `bundled` for the copy in the Agent SDK, and `unknown` for the rest. An update goes through that owner.

An npm global is pinned with `--prefix`, because npm otherwise installs to the prefix of whichever node runs it. It uses the prefix's own npm, or any npm on `PATH` if the prefix has none. Claude Code under pnpm needs pnpm 10.4 or newer, to allow its install script. With an older one, `canUpdate` is false and `reason` says so.

On Windows, `canUpdate` is false.

## Status fields

- **`updateOffered`** means a newer version, an installer to run and a version the engine would accept. A new Codex major comes back as not offered, with `reason`. `compatible` and `latestCompatible` apply the engine's own check, so Claude Code has a floor and no ceiling.
- **`latest`** is undefined when the lookup fails, which is a normal result. It comes from npm, from Homebrew for a cask (casks trail npm), and from the SDK's pairing for a bundled Claude. The lookup sends a fixed URL and nothing else.
- **`sdk`**, on a Claude status when the installed SDK can be read, is `{ version, claudeCode, latest }`: the installed Agent SDK, the Claude Code it was built with and the latest SDK. With a shared install, `version` against `sdk.claudeCode` is the gap between the binary and the SDK.

## Which Claude runs

- **A bundled Claude**, which is what runs without `executable`, reports the bundled version and what the latest SDK pairs with. Only a new release of your app can move it, so `canUpdate` is false.
- **A shared Claude.** `findSharedClaude({ env })` returns the absolute path and version of the `claude` on `PATH`, so an app can run the install the terminal uses: pass `path` as `executable`. It returns nothing if that `claude` is missing, doesn't run or is below the minimum, so the app can fall back to the bundled copy. An app started with a thin `PATH`, as under launchd, should pass an `env` with a fuller one.

## Going to an exact version

`{ version }` goes to an exact version, for a rollback, when `canPinVersion` is true. Homebrew and `codex update` only go to their latest. The version must be strict semver and one the engine would accept.

## How an update is verified

An update counts when the binary says so. It re-reads the version and rechecks compatibility. For Claude it also opens an Agent SDK session on the new binary, with no prompt and so no model turn, and the session must report the same version.

A success returns `{ outcome, from, to, ... }`. Anything else throws `RuntimeUpdateError`, with `from`, `to`, `target`, `exitCode`, `output` and `command` where they're known. Its `reason` is one of:

- Before anything ran: `invalid-version`, `not-updatable`, `lookup-failed`, `incompatible-target`, `in-progress`
- After: `installer-failed`, `version-mismatch`, `incompatible-result`, `sdk-check-failed`

## Release notes

`runtimeReleaseNotes(provider, { from, to })` returns `[{ version, text }]` for the versions after `from` up to `to`, newest first.

- Codex's come from its GitHub releases, leaving out prereleases unless `to` is one. Claude Code's come from its changelog, where not every version has an entry.
- They're as published minus the Markdown, not summarised. They're outside text, so treat them as data.
- Any failure gives fewer notes or none, never an error.
- GitHub allows about 60 API calls an hour without a sign-in, and Codex's notes cost one per minor version and one per release, so a long jump reads only the newest ten minors.

## Without an engine

`runtimeVersion(provider, options)` and `updateRuntime(provider, options)` are also exported, for checking a runtime without an engine. `RuntimeHost`, passed as `host`, replaces what they touch in tests.

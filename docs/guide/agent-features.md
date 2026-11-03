# Agent features

Support varies by runtime. See [Capabilities](/runtimes/capabilities) for the comparison.

## Goals

`setGoal(objective, { tokenBudget })` (Codex) keeps the agent working over several turns. The turns it starts itself arrive through `thread.subscribe`, and `goal.updated` reports progress.

## Code review

`review({ type: "uncommitted" | "base-branch" | "commit" | "custom" })` runs a review as a turn of its own. Codex uses its review mode, and the other runtimes get a review prompt.

## Shell and background tasks

- `shell(command)` (Codex) runs a command as the user, unsandboxed, and it shows in the thread like the agent's own.
- `tasks()` lists background work still running: Codex's background terminals, and Claude's background shells, monitors and subagents.
- `stopTask(id)` stops one.

## MCP servers

`setMcpServers`, `reconnectMcp`, `toggleMcp`, `mcpLogin` and `readMcpResource` change MCP servers while a thread runs, as far as the runtime allows. `mcp.status` events report servers starting, failing and needing sign-in.

`CodexEngine.mcpStatus()` also lists the app-server's MCP servers before any thread starts.

### Telling a Codex thread its tool names

`codex.listMcpTools` tells a new thread its MCP tool names, so the model needn't search `ALL_TOOLS`. It defaults to false and runs on new and forked threads, not resumes.

Servers with more than 60 tools, connector servers, and names that Codex must hash are shown by count for lookup in `ALL_TOOLS`. Empty or failed listings are skipped, but a closed connection still fails startup.

## Skills and plugins

`reloadSkills()` and `reloadPlugins()` pick up changes on disk. `engine.plugins()`, `installPlugin()` (Codex) and `setSkillEnabled()` (Codex) manage them for every thread.

## Commands

`engine.commands({ cwd })` lists what a thread in that folder could use: Claude Code's slash commands (skills and plugin commands included), and Codex's enabled skills plus `/compact`.

Claude's list comes from a probe that loads the folder's settings but starts no MCP server, so commands that MCP servers add are left out.

## Prewarm, file search and config

- `engine.prewarm()` starts the runtime early. On Claude, `prewarm(threadOptions)` also opens the next thread's process, so the next `startThread` with the same options is ready at once.
- `engine.searchFiles(query, { cwd })` finds files for `@` mentions, using Codex's own index or a local fuzzy search that skips what git ignores.
- `engine.config({ cwd })` returns the runtime's effective settings and where each layer came from.

## Realtime

`thread.realtime({ output: "audio" | "text" })` (Codex) opens a live session. Send text or microphone audio, and transcripts and audio come back as `realtime.*` events.

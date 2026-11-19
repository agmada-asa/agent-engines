# Public API

## `createEngine`

`createEngine(provider, options)` returns an `Engine`, which is a `CodexEngine`, `ClaudeEngine` or `AcpEngine` underneath. Nothing starts until first use.

## `Engine`

| Area | Methods |
| --- | --- |
| Runtime | `availability()`, `capabilities()`, `runtimeVersion()`, `updateRuntime()`, `models()`, `usage()`, `commands()`, `config()`, `prewarm()`, `subscribe()`, `close()` |
| Threads | `startThread()`, `resumeThread()`, `forkThread()`, `listThreads()`, `readThread()`, `renameThread()`, `archiveThread()`, `unarchiveThread()`, `deleteThread()` |
| Account | `login()`, `logout()` |
| Files and extensions | `searchFiles()`, `plugins()`, `installPlugin()`, `uninstallPlugin()`, `setSkillEnabled()` |

`CodexEngine.mcpStatus()` also lists the app-server's MCP servers before any thread starts.

## `Thread`

| Area | Methods |
| --- | --- |
| Turns | `run(input, { model, effort, fastMode, serviceTier, access, mode, outputSchema })`, `compact()`, `review()`, `activeTurn`, `lastTurn()`, `interruptTurn(turnId)`, `subscribe(listener)` |
| History | `history()`, `rewind(beforeTurnId, { files })`, `rename()`, `export()`, `contextUsage()`, `subagentTranscript(agentId)` |
| Work | `setGoal()`, `goal()`, `clearGoal()`, `shell()`, `tasks()`, `stopTask()` |
| MCP and extensions | `mcpStatus()`, `setMcpServers()`, `reconnectMcp()`, `toggleMcp()`, `mcpLogin()`, `readMcpResource()`, `reloadSkills()`, `reloadPlugins()` |
| Settings | `settings()` and `setSetting(id, value)` (ACP) for the session settings the agent lists |
| Other | `realtime()` for a live voice or text session, and `close()` |

## `Turn`

A turn is an async iterable of `AgentEvent`s, plus `id`, `steer()`, `interrupt()` and `result`. `result` never rejects.

On Claude, `interrupt()` also takes back the turn's steers that haven't run yet. If Claude has already started one, it runs as a new turn, and the interrupted turn gets a `warning` notice saying so. If Claude neither gives back the turn's own prompt nor starts it, the turn ends as `interrupted` after `ClaudeEngineOptions.interruptGraceMs` (15 seconds by default).

For Codex, `ModelInfo.serviceTiers` lists `ServiceTierInfo` entries. `Thread.serviceTier` and `TurnResult.serviceTier` use `ServiceTierSelection` to distinguish requested and acknowledged settings. See [speed tiers](/guide/models#requested-and-accepted-tiers) for the scope and confirmation limits.

## `AgentEvent`

See [Events](/guide/events). Events from a subagent carry its `agentId`.

## Errors

`AgentEngineError` and its subclasses:

- `ConversationRevertError`
- `RuntimeAuthError`
- `RuntimeCompatibilityError`
- `RuntimeConnectionError`
- `RuntimeModelSubstitutionError`
- `RuntimeModelUnavailableError`
- `RuntimeProtocolError`
- `RuntimeUpdateError`
- `SteerRejectedError`
- `UnsupportedFeatureError`

## Presets

For untrusted input: `lockedDownThread()`, `lockedDownCodexLaunch()`, `minimalEnvironment()`.

Related: `LOCKED_DOWN_CODEX_FEATURES`, `configuredMcpServerNames()`, `readConfiguredMcpServerNames()`.

## Helpers

- Handoffs: `renderTranscript()`
- Checkpoints: `CheckpointStore`, `gitRepository()`, `snapshotTree()`
- Runtime versions: `runtimeVersion()`, `updateRuntime()`, `findSharedClaude()`, `runtimeReleaseNotes()`
- Compatibility: `checkMinimumVersion()`, `codexVersionIncompatibility()`, `diffModelCatalog()`, `hasModelCatalogDrift()`
- Launching Codex yourself: `appServerArgs()`, with the `SpawnCodexProcess` and `SpawnAcpProcess` options
- JSON-RPC errors a call can throw: `CodexRpcError`, `AcpRpcError`

## Constants

`CODEX_CAPABILITIES`, `CLAUDE_CAPABILITIES`, `CLAUDE_CODE_MIN_VERSION`, `CODEX_PROTOCOL_VERSION`, `ACP_PROTOCOL_VERSION`, `ACP_AGENTS`.

## Internals

The pieces the engines are built from are in a second entry point, `agent-engines/internals`. They follow each runtime's own format closely, so they can change in any minor release.

```ts
import { CodexClient, CodexNormalizer } from "agent-engines/internals";
```

- JSON-RPC clients: `CodexClient`, `AcpClient`
- Normalisers: `CodexNormalizer`, `ClaudeNormalizer`, `AcpNormalizer`, `acpTool()`
- Per-runtime mappers: `codexCommands()`, `codexModelInfo()`, `codexThreadSummary()`, `codexUsage()`, `codexGoal()`, `codexRequest()`, `classifyCodexError()`, `claudeCommands()`, `claudeModelInfo()`, `claudeUsageReport()`, `claudeHistory()`, `claudeUsage()`, `classifyClaudeError()`
- Handoff seeds: `seedPreamble()`, `responsesItems()`
- File search and diffs: `localFileSearch()`, `fuzzyScore()`, `unifiedDiff()`
- Review: `reviewPrompt()`
- Checkpoint steps: `restoreTree()`, `reverseChanges()`, `reverseDiff()`
- Protocol checks: `CODEX_PROTOCOL_CONTRACT`, `codexProtocolProblems()`, `readCodexProtocolSurface()`, `parseRuntimeVersion()`

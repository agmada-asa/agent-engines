# agent-engines

Run Codex, Claude and ACP agents from your own TypeScript app, on the subscriptions already signed in on the machine.

agent-engines puts three kinds of runtime behind one thread, turn and event API:

- **Codex**, through `codex app-server` over stdio (JSON-RPC, typed with bindings generated from a pinned Codex CLI).
- **Claude**, through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
- **Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)**, such as OpenCode (`opencode acp`) and Gemini CLI (`gemini --acp`).

An app can start or resume a thread, run a turn, steer it, interrupt it, compact it and read one event stream without caring which runtime is underneath. It can also fork a thread, rewind it to an earlier turn (files too, where the runtime keeps checkpoints), list and read saved threads, switch to plan mode, ask for a reply that matches a JSON Schema, attach files, set a goal, run a code review, and move a conversation from one runtime to another. Approvals and questions from the agent arrive as events to answer, and `usage()` reads the plan's limits without spending a turn.

Runtimes differ, so every engine has every method, and `capabilities()` says which ones work. A method the runtime cannot do throws `UnsupportedFeatureError` rather than doing something else quietly.

It runs the agents in [Blitz](https://github.com/agmada-asa/Blitz).

It is the provider mechanics only. Which tools an agent may use, who approves what, retries, job leases and UI all stay in the app. Restrictive settings are available as presets you opt into, not defaults.

It uses the sign-ins from `codex login` and `claude`. By default it refuses to run on an API key, so turns are never billed per token by accident; set `requireSubscription: false` to allow it.

## Install

Node 22 or later, ESM only.

```sh
npm install agent-engines
```

It also works as a git or local `file:` dependency; `prepare` builds `dist/`.

Codex needs the `codex` CLI on `PATH` (or `executable`). Claude uses the Claude Code binary the SDK bundles unless you pass `executable`.

## Use

```ts
import { createEngine } from "agent-engines";

const engine = createEngine("claude"); // or "codex"

const ready = await engine.availability();
if (!ready.ready) throw new Error(ready.message);

const thread = await engine.startThread({
  cwd: "/path/to/workspace",
  model: "claude-haiku-5-5",
  effort: "low",
  access: "full",
  mcpServers: { notes: { command: "node", args: ["notes-mcp.js"] } },
});

const turn = thread.run("Tidy the README.");
for await (const event of turn) {
  if (event.type === "text.delta") process.stdout.write(event.delta);
  if (event.type === "request" && event.request.kind === "approval") await event.request.respond({ decision: "allow" });
}
const result = await turn.result; // { status: "completed" | "interrupted" | "failed", text, usage, error }

// Save thread.id; later, in the same cwd:
const again = await engine.resumeThread(thread.id, { cwd: "/path/to/workspace" });
```

While a turn runs, `turn.steer("…")` adds a message to it and `turn.interrupt()` stops it. `thread.compact()` compacts the context as a turn of its own. `engine.deleteThread(id, { cwd })` removes what the runtime keeps of a thread on disk, subagents included.

An ACP agent needs its command:

```ts
import { ACP_AGENTS, createEngine } from "agent-engines";

const opencode = createEngine("acp", ACP_AGENTS.opencode); // or { command: "my-agent", args: ["--acp"] }
```

## Public API

- `createEngine(provider, options)`: a `CodexEngine`, `ClaudeEngine` or `AcpEngine`. Nothing starts until first use.
- `Engine`:
  - runtime: `availability()`, `capabilities()`, `models()`, `usage()`, `commands()`, `config()`, `prewarm()`, `subscribe()` for engine-wide events, `close()`.
  - threads: `startThread()`, `resumeThread()`, `forkThread()`, `listThreads()`, `readThread()`, `renameThread()`, `archiveThread()`, `unarchiveThread()`, `deleteThread()`.
  - account: `login()`, `logout()`.
  - files and extensions: `searchFiles()`, `plugins()`, `installPlugin()`, `uninstallPlugin()`, `setSkillEnabled()`.
  - `CodexEngine.mcpStatus()` also lists the app-server's MCP servers before any thread starts.
- `Thread`:
  - turns: `run(input, { model, effort, fastMode, access, mode, outputSchema })`, `compact()`, `review()`, `activeTurn`, `lastTurn()`, `interruptTurn(turnId)`, `subscribe(listener)`.
  - history: `history()`, `rewind(beforeTurnId, { files })`, `rename()`, `export()`, `contextUsage()`, `subagentTranscript(agentId)`.
  - work: `setGoal()`, `goal()`, `clearGoal()`, `shell()`, `tasks()`, `stopTask()`.
  - MCP and extensions: `mcpStatus()`, `setMcpServers()`, `reconnectMcp()`, `toggleMcp()`, `mcpLogin()`, `readMcpResource()`, `reloadSkills()`, `reloadPlugins()`.
  - `realtime()` for a live voice or text session, and `close()`.
- `Turn`: async-iterable `AgentEvent`s, plus `id`, `steer()`, `interrupt()` and `result` (never rejects).
- `AgentEvent`: see below. Events from a subagent carry its `agentId`.
- Errors: `AgentEngineError` and its subclasses (`RuntimeAuthError`, `RuntimeCompatibilityError`, `SteerRejectedError`, `UnsupportedFeatureError`, `ConversationRevertError`…).
- Presets: `lockedDownThread()`, `lockedDownCodexLaunch()`, `minimalEnvironment()` for untrusted input.
- Helpers: `renderTranscript()` and `seedPreamble()` for handoffs, `localFileSearch()` and `fuzzyScore()`, `unifiedDiff()`, `reviewPrompt()`.
- Lower level: `CodexClient` and `AcpClient` (the JSON-RPC clients), `CodexNormalizer`, `ClaudeNormalizer`, `AcpNormalizer`, and the compatibility helpers in `compat.ts`.

### Thread options

| Option | Codex | Claude | ACP |
| --- | --- | --- | --- |
| `cwd` | thread cwd | process cwd | session cwd |
| `model`, `effort`, `fastMode` | thread and per-turn | SDK options and per-turn controls | the session's `model` and `thought_level` options |
| `access` | approval policy, sandbox and reviewer | permission mode | answers permission requests itself where it can |
| `mode` (`default`, `plan`) | the thread's collaboration mode, set before the turn | plan permission mode | the session mode named plan |
| `instructions` | developer instructions | appended to Claude Code's system prompt | not sent |
| `mcpServers` | per-thread `mcp_servers` config | SDK `mcpServers` (also in-process `sdk` servers, and `alwaysLoad`) | `session/new` servers |
| `env` | engine-wide only (`CodexEngineOptions.env`) | per thread | engine-wide only |
| `strictModel` | fails a silent model swap | same | |
| `title` | `thread/name/set` | SDK `title` | not supported |
| `outputSchema` | per-turn `outputSchema` | `outputFormat` | not supported |
| `limits` | not supported | `maxTurns`, `maxBudgetUsd`, task budget | not supported |
| `agents` | agent roles (`agents.<name>` config with a role file) | SDK `agents` | not supported |
| `additionalDirectories` | workspace sandbox writable roots | SDK `additionalDirectories` | sent when the agent takes them |
| `fileCheckpoints` | a git snapshot of the folder before each turn, for `rewind({ files: true })` | file checkpointing, for `rewind({ files: true })` | ignored |
| `seed` | injected as history | put before the first message | put before the first message |
| `fallbackModels`, `promptSuggestions`, `progressSummaries` | ignored | SDK `fallbackModel`, `promptSuggestions`, `agentProgressSummaries` | ignored |

`access` is one of `full`, `auto` (the runtime's own reviewer decides routine approvals), `accept-edits` (edits go ahead; on Codex the same as `ask`, since the workspace sandbox already allows them), `ask` and `read-only`. "Not supported" options throw `UnsupportedFeatureError` when set, rather than being dropped.

Anything runtime-specific goes in `codex: {…}` (approval policy, approvals reviewer, sandbox, network (also reasserted with the sandbox and approval policy on every turn), `config` overrides, host-answered `dynamicTools`, ephemeral, `listMcpTools` to tell a new thread its MCP tool names so the model needn't search `ALL_TOOLS`) or `claude: {…}` (setting sources, built-in tools, allowed and disallowed tools, permission mode, skills, system prompt, host `hooks`, local `plugins`, and `extra` for any other SDK option).

### Events

`turn.started`, `text.delta` / `text.done`, `reasoning.delta` / `reasoning.done`, `tool.started` / `tool.output.delta` / `tool.progress` / `tool.completed`, `file.changed`, `diff.updated`, `plan.updated`, `plan.proposal.delta` / `plan.proposal.done`, `status`, `task.started` / `task.progress` / `task.ended`, `subagent.started` / `subagent.ended`, `request` / `request.resolved`, `usage`, `rate-limit`, `compacted`, `model.rerouted`, `notice`, `hook.started` / `hook.completed`, `goal.updated`, `mcp.status`, `thread.renamed`, `prompt.suggestion`, `realtime.*`, `turn.completed`, `turn.failed`.

`engine.subscribe()` gets the events that belong to no thread: `account.changed` and `notice` (a config warning, a deprecation).

The union grows in minor releases. A `switch` on `event.type` should have a default branch rather than an exhaustive check that fails to compile when a new member arrives.

#### Live progress

These are for showing work as it happens. None of them changes a turn's result: `tool.completed` still carries the whole output and `turn.completed` the reply.

| Event | Codex | Claude |
| --- | --- | --- |
| `tool.output.delta` | command output as it streams | not sent; the SDK does not stream command output |
| `tool.progress` | MCP tool progress `message` | `elapsedSeconds` of a running tool |
| `diff.updated` | the turn's whole unified diff so far, replacing the last one | not sent; use `file.changed` |
| `plan.updated` | the checklist, whole each time, with an optional `explanation` | each TodoWrite list, with `itemId` of the call |
| `plan.proposal.delta` / `.done` | a plan streamed in plan mode; `.done` has the final text | `.done` with the plan when Claude asks to leave plan mode |
| `status` | from the thread status: `working`, `waiting` (with `waitingOn`), `idle`; `compacting`; `retrying` | `working`, `compacting`, `retrying` with attempt and delay |
| `task.started` / `task.ended` | not sent | background shells, monitors, workflows and MCP tasks |
| `task.progress` | not sent | the same tasks, and subagents (`taskId` is the `subagentId`) |

```ts
thread.subscribe((event) => {
  switch (event.type) {
    case "tool.output.delta": appendToTerminal(event.itemId, event.delta); break;
    case "plan.updated": showChecklist(event.steps); break; // { step, status: "pending" | "in-progress" | "completed" }
    case "status": showStatus(event.status.state); break;
    case "task.progress": showTask(event.taskId, event.summary ?? event.description); break;
    default: break;
  }
});
```

Limits worth knowing:

- `status` is a hint for a status line, not a turn lifecycle; use `turn.completed` and `turn.failed` for that. A Codex `idle` usually arrives after `turn.completed`, so it reaches `thread.subscribe` but not the turn's iterator.
- Claude reports `idle` and `waiting` only through session-state events, which the SDK sends when a session opts in. The engine does not opt in, so from Claude expect `working`, `compacting` and `retrying`; a pending `request` is the sign it is waiting.
- `retrying` means the runtime will try the model request again; the turn has not failed.
- A task a subagent launched carries that subagent's `agentId`. `task.ended` needs the `task.started` from the same thread handle, so a task begun before a resume does not end on the new handle.

Codex marks each agent message's `phase` on `text.delta` and `text.done`: `commentary` for a progress note between tool calls, `answer` for the reply. Claude's text events have no phase. A turn's result text is never a progress note.

`file.changed` lists the files one tool call changed, from the main agent or a subagent (tagged with its `agentId`): Codex's `apply_patch` edits, and Claude's Edit, MultiEdit, Write and NotebookEdit. Each `diff` is unified hunks with no `---`/`+++` header, the same from both runtimes: a new file is all `+` lines, a deleted one all `-`, and a Codex move names the new path in `movedTo`. Files a shell command writes are not reported by either runtime.

A `request` is an approval, a question (Claude's AskUserQuestion, Codex's user-input request) or an MCP elicitation. Call its `respond` once; an unanswered request is cancelled when the turn ends. A Codex file-change approval carries the proposed `changes`, with diffs, so the user can review them before allowing.

A failed turn has an `error.kind`: `usage-limit` and `rate-limit` come with `resetsAt` when the runtime says, so an app can try again then.

Network failures have kind `connection`. Authentication and context errors stay distinct even if an earlier usage report was rejected. The engine restores runtime connections and thread handles; the app decides whether and when to retry interrupted work, persists pending retries and cancels them when the user stops. A transient overload does not inherit an unrelated subscription reset time.

`thread.subscribe` sees every event on the thread, including turns the agent starts by itself (Claude does when a background subagent reports back).

### Usage and commands

`engine.usage()` reads the signed-in plan's windows (Codex `account/rateLimits/read`; Claude the data behind `/usage`) without a model call. Each window has a `kind` (`session`, `weekly`, `monthly`), `usedPercent` and `resetsAt`, and `model` when it limits one model family. An account with no plan limits reports `available: false`.

`engine.commands({ cwd })` lists what a thread in that folder could use: Claude Code's slash commands (skills and plugin commands included), and Codex's enabled skills plus `/compact`. Claude's list comes from a probe that loads the folder's settings but starts no MCP server, so commands MCP servers add are left out.

### Capabilities

`await engine.capabilities()` describes what the runtime can do, so a UI shows only the controls that work. Every `false` is enforced: the matching method throws `UnsupportedFeatureError` (a test checks every flag on every engine). The short version:

| | Codex | Claude | ACP |
| --- | --- | --- | --- |
| steer, compact | yes | yes | no |
| fork | yes, through any turn | yes, through any turn | whole session, if the agent offers it |
| rewind | conversation, and files: a git snapshot per turn with `fileCheckpoints`, else the recorded edits undone | conversation, and files with `fileCheckpoints` | no |
| list and read threads | yes | yes | if the agent can list and load sessions |
| rename, archive | both | rename only | no |
| plan mode | yes | yes | if the agent has a plan mode |
| structured output | yes | yes | no |
| files | named by path | PDFs and text as documents | embedded, or linked |
| goals | yes | no | no |
| review | native | a review prompt | a review prompt |
| shell, background tasks | yes | tasks only | no |
| live MCP changes | reload, sign-in, resources | replace, restart, toggle, resources | no |
| sign-in from the app | yes | no | no |
| turn limits | no | yes | no |
| realtime voice | yes | no | no |

### History, fork and rewind

A turn's ID is the one the runtime stores (Claude: the prompt's UUID), so `history()` and `readThread()` give turns whose IDs `forkThread`, `rewind` and `interruptTurn` take.

```ts
const turns = await thread.history(); // [{ id, status, entries: TranscriptEntry[] }]
const branch = await engine.forkThread(thread.id, { cwd, throughTurnId: turns[0].id });

// Edit an earlier prompt: rewind to before it, then send the new text.
await thread.rewind(turns[1].id, { files: true });
await thread.run("The edited prompt");
```

Files come back in one of two ways, reported as `files.method`:

- `checkpoint`: Claude's own file checkpoints (`fileCheckpoints: true`), or on Codex a git snapshot the engine takes before each turn when the thread has `fileCheckpoints` and its folder is in a git repository. The snapshot goes into git's object store through a temporary index, so branches, the index and the working tree are not touched, and its ID is kept under the repository's git folder. A rewind restores whatever changed in the thread's folder since then, including files a shell command wrote, and anyone else's edits there in the meantime. Untracked files over 10 MB are left out.
- `edits` (Codex without a snapshot): the edits Codex recorded in the dropped turns are undone, newest first. Files a shell command wrote are left as they are, and a file whose text has changed since is listed in `files.skipped`.

Files are put back before the conversation is rewound. If Codex then fails to drop the turns, `rewind` throws `ConversationRevertError`: its `files` says what was put back, and the turns are still in the conversation, so tell the agent in the next prompt.

Codex itself only rewinds the conversation, and turns the agent starts on its own (a goal's follow-on turns) get no snapshot. Claude cannot rewind past its first turn (start a new thread instead). `listThreads({ cwd, search, limit })` lists threads newest first, including ones started outside this library; Codex leaves subagents out.

### Plan mode and access per turn

`mode` and `access` work on the thread and on any turn, and a turn's choice sticks:

```ts
await thread.run("Plan the migration", { mode: "plan" }).result;
await thread.run("Go ahead", { mode: "default", access: "accept-edits" }).result;
```

On Claude, a new access level restarts the thread's process (the session is kept), because Claude Code only takes some of it at launch. A mode change does not.

Claude's plan mode ends with a `request` whose `action` is `plan` and whose `plan` is the proposal. Allow it to leave plan mode and carry the plan out; deny it with a `message` to keep planning. Codex's plan mode ends the turn with `plan.proposal.done`; send the next turn with `mode: "default"` to go ahead.

### Structured output

```ts
const result = await thread.run("Classify this message", {
  outputSchema: { type: "object", properties: { kind: { enum: ["answer", "done", "blocked"] } }, required: ["kind"] },
}).result;
result.output; // { kind: "answer" }, or undefined if the reply was not valid JSON
```

A schema on the thread applies to every turn; a turn's own wins, and `outputSchema: null` turns it off for one turn. Claude takes a schema per process, so changing it restarts the process before the turn.

### Files

`run({ text, images, files })` takes files by path or as base64. Claude reads PDFs and text files as documents; Codex, and anything Claude cannot read, gets the paths named at the end of the message (base64 files are saved to a temporary folder first). ACP agents get the content embedded where they accept it, else a link.

### Goals, review, shell and tasks

- `setGoal(objective, { tokenBudget })` (Codex) keeps the agent working over several turns; the turns it starts itself arrive through `thread.subscribe`, and `goal.updated` reports progress.
- `review({ type: "uncommitted" | "base-branch" | "commit" | "custom" })` runs a review as a turn of its own. Codex uses its review mode; the others get a review prompt.
- `shell(command)` (Codex) runs a command as the user, unsandboxed, and it shows in the thread like the agent's own.
- `tasks()` lists background work still running: Codex's background terminals, Claude's background shells, monitors and subagents. `stopTask(id)` stops one.

### MCP, skills and plugins

`setMcpServers`, `reconnectMcp`, `toggleMcp`, `mcpLogin` and `readMcpResource` change MCP servers while a thread runs, as far as the runtime allows (see the table above). `mcp.status` events report servers starting, failing and needing sign-in. `reloadSkills()` and `reloadPlugins()` pick up changes on disk; `engine.plugins()`, `installPlugin()` (Codex) and `setSkillEnabled()` (Codex) manage them for every thread.

### Sign-in and accounts

`engine.login({ method: "browser" | "device-code" })` (Codex) returns a URL, and a code for device sign-in; `done` settles when it finishes. Use `CodexEngineOptions.home` (`CODEX_HOME`) or `ClaudeEngineOptions.configDir` (`CLAUDE_CONFIG_DIR`) to run two accounts side by side, each with its own `usage()`.

### Moving a conversation between runtimes

```ts
const transcript = await claudeThread.export();
const codexThread = await codex.startThread({ cwd, seed: transcript });
```

Codex adds the earlier conversation to the thread's history; Claude and ACP agents get it before the first message. Reasoning is left out and long tool output is shortened.

### Prewarm, file search and config

- `engine.prewarm()` starts the runtime early. On Claude, `prewarm(threadOptions)` also opens the next thread's process, so the next `startThread` with the same options is ready at once.
- `engine.searchFiles(query, { cwd })` finds files for `@` mentions: Codex's own index, or a local fuzzy search that skips what git ignores.
- `engine.config({ cwd })` returns the runtime's effective settings and where each layer came from.

### Realtime

`thread.realtime({ output: "audio" | "text" })` (Codex) opens a live session; send text or microphone audio, and transcripts and audio come back as `realtime.*` events.

## Behaviour worth knowing

- **One Codex child per engine.** All Codex threads share one `codex app-server`. If it exits, running turns fail with a `connection` error and the next call starts a new one and resumes the thread.
- **One Claude Code process per thread.** It stays up while the thread is open, so close threads you are not using.
- **Process lifetime.** Agents run as children of your process. If your process exits, running turns stop; resume the thread, check `lastTurn()` and send again.
- **Images** go by path or base64 to every runtime; Claude's are read and sent as base64.
- **One ACP agent process per engine**, shared by its threads, like Codex.
- With `access: "full"` the Claude SDK prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning. It is harmless: AskUserQuestion still reaches `canUseTool` and surfaces as a `request` (covered by the live test).

## Compatibility checks

- `src/codex/protocol/` is generated from the Codex CLI pinned in `src/codex/protocol/version.ts`. To move to a newer Codex: install it, bump `CODEX_PROTOCOL_VERSION`, run `npm run generate:protocol`, review the diff.
- Codex at or above the pinned version, within the same major, is accepted. Real drift fails where it happens.
- The bindings are generated with Codex's experimental API (plan mode, background terminals and realtime need it), and the client opts in to it on `initialize`.
- `npm run check:runtimes` checks the installed Codex and Claude Code: versions, every app-server method and enum value the engines use (`CODEX_PROTOCOL_CONTRACT`), sign-in, and each catalogue. It starts no model turn. `--expect models.json` fails on catalogue drift. CI runs it weekly against the latest CLIs.

## ACP agents

`AcpEngine` drives any agent that speaks ACP version 1 over stdio. It starts one agent process per engine and opens a session per thread. What it can do comes from the agent's `initialize` answer, so `capabilities()` differs from agent to agent; `ACP_AGENTS` has the commands for OpenCode and Gemini CLI.

- ACP has no steering, so `steer` throws `SteerRejectedError`; there is no compaction, rewind or structured output.
- Permission requests surface as `request` events. `access: "full"` allows each one once without asking, `read-only` refuses, `accept-edits` allows edits and asks about the rest.
- Resuming loads the session, which replays its history into `history()`. `models()` and `commands()` open a session in a temporary folder when no thread is open, and the agent may keep it in its own list.
- File reads, writes and terminals stay with the agent: the engine does not offer the client file system or terminal.

## Development

```sh
git clone https://github.com/agmada-asa/agent-engines
cd agent-engines && npm install
npm test            # unit tests with fake transports
npm run typecheck
AGENT_ENGINES_LIVE=1 npm run test:live   # real turns on cheap models, in a /tmp scratch dir
```

The live tests run a steered turn, an interrupted turn, a resume, a compaction and a delete on each runtime, plus a Claude question round trip. A second scenario checks plan mode, structured output, context usage, history, rename, fork, rewind with files, a handoff seed and a review. Override the models with `AGENT_ENGINES_CLAUDE_MODEL` and `AGENT_ENGINES_CODEX_MODEL`.

## Licence

MIT. See [LICENSE](LICENSE).

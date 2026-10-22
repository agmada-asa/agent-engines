# agent-engines

One TypeScript layer for running coding agents on two runtimes:

- **Codex**, through `codex app-server` over stdio (JSON-RPC, typed with bindings generated from a pinned Codex CLI).
- **Claude**, through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

Both sit behind the same thread, turn and event API, so an app can start or resume a thread, run a turn, steer it, interrupt it, compact it and read one event stream without caring which runtime is underneath.

It is the provider mechanics only. Which tools an agent may use, who approves what, retries, job leases and UI all stay in the app. Restrictive settings are available as presets you opt into, not defaults.

It runs on the sign-ins already on the machine (`codex login`, `claude`). By default it refuses to run on an API key, so turns are never billed per token by accident; set `requireSubscription: false` to allow it.

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

## Public API

- `createEngine(provider, options)`: a `CodexEngine` or `ClaudeEngine`. Nothing starts until first use.
- `Engine`: `availability()`, `models()`, `startThread()`, `resumeThread()`, `deleteThread()`, `close()`. `CodexEngine.mcpStatus()` also lists the app-server's MCP servers before any thread starts.
- `Thread`: `run(input, { model, effort, fastMode })`, `compact()`, `activeTurn`, `lastTurn()`, `interruptTurn(turnId)`, `subscribe(listener)`, `subagentTranscript(agentId)`, `mcpStatus()`, `close()`.
- `Turn`: async-iterable `AgentEvent`s, plus `id`, `steer()`, `interrupt()` and `result` (never rejects).
- `AgentEvent`: see below. Events from a subagent carry its `agentId`.
- Errors: `AgentEngineError` and its subclasses (`RuntimeAuthError`, `RuntimeCompatibilityError`, `SteerRejectedError`…).
- Presets: `lockedDownThread()`, `lockedDownCodexLaunch()`, `minimalEnvironment()` for untrusted input.
- Lower level: `CodexClient` (the JSON-RPC client), `CodexNormalizer`, `ClaudeNormalizer`, and the compatibility helpers in `compat.ts`.

### Thread options

| Option | Codex | Claude |
| --- | --- | --- |
| `cwd` | thread cwd | process cwd |
| `model`, `effort`, `fastMode` | thread and per-turn | SDK options and per-turn controls |
| `access` (`full`, `ask`, `read-only`) | approval policy and sandbox | permission mode |
| `instructions` | developer instructions | appended to Claude Code's system prompt |
| `mcpServers` | per-thread `mcp_servers` config | SDK `mcpServers` (also in-process `sdk` servers, and `alwaysLoad`) |
| `env` | engine-wide only (`CodexEngineOptions.env`) | per thread |
| `strictModel` | fails a silent model swap | same |

Anything runtime-specific goes in `codex: {…}` (approval policy, approvals reviewer, sandbox, network (also reasserted with the sandbox and approval policy on every turn), `config` overrides, host-answered `dynamicTools`, ephemeral) or `claude: {…}` (setting sources, built-in tools, allowed and disallowed tools, permission mode, skills, system prompt, and `extra` for any other SDK option).

### Events

`turn.started`, `text.delta` / `text.done`, `reasoning.delta` / `reasoning.done`, `tool.started` / `tool.completed`, `file.changed`, `subagent.started` / `subagent.ended`, `request` / `request.resolved`, `usage`, `rate-limit`, `compacted`, `model.rerouted`, `turn.completed`, `turn.failed`.

Codex marks each agent message's `phase` on `text.delta` and `text.done`: `commentary` for a progress note between tool calls, `answer` for the reply. Claude's text events have no phase. A turn's result text is never a progress note.

A `request` is an approval, a question (Claude's AskUserQuestion, Codex's user-input request) or an MCP elicitation. Call its `respond` once; an unanswered request is cancelled when the turn ends. A Codex file-change approval carries the proposed `changes`, with diffs, so the user can review them before allowing.

A failed turn has an `error.kind`: `usage-limit` and `rate-limit` come with `resetsAt` when the runtime says, so an app can try again then.

Network failures have kind `connection`. Authentication and context errors stay distinct even if an earlier usage report was rejected. The engine restores runtime connections and thread handles; the app decides whether and when to retry interrupted work, persists pending retries and cancels them when the user stops. A transient overload does not inherit an unrelated subscription reset time.

`thread.subscribe` sees every event on the thread, including turns the agent starts by itself (Claude does when a background subagent reports back).

## Behaviour worth knowing

- **One Codex child per engine.** All Codex threads share one `codex app-server`. If it exits, running turns fail with a `connection` error and the next call starts a new one and resumes the thread.
- **One Claude Code process per thread.** It stays up while the thread is open, so close threads you are not using.
- **Process lifetime.** Agents run as children of your process. If your process exits, running turns stop; resume the thread, check `lastTurn()` and send again.
- **Claude images** must be base64. Codex takes a path or base64.
- With `access: "full"` the Claude SDK prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning. It is harmless: AskUserQuestion still reaches `canUseTool` and surfaces as a `request` (covered by the live test).

## Compatibility checks

- `src/codex/protocol/` is generated from the Codex CLI pinned in `src/codex/protocol/version.ts`. To move to a newer Codex: install it, bump `CODEX_PROTOCOL_VERSION`, run `npm run generate:protocol`, review the diff.
- Codex at or above the pinned version, within the same major, is accepted. Real drift fails where it happens.
- `npm run check:runtimes` checks the installed Codex and Claude Code: versions, every app-server method and enum value the engines use (`CODEX_PROTOCOL_CONTRACT`), sign-in, and each catalogue. It starts no model turn. `--expect models.json` fails on catalogue drift. CI runs it weekly against the latest CLIs.

## Adding another runtime

ACP agents (OpenCode and others) are left out for now. One would slot in as a third `Engine`: an `AcpEngine` that owns the ACP child, maps `session/new` and `session/load` to `startThread` and `resumeThread`, `session/prompt` to a turn and `session/cancel` to `interrupt`, normalises `session/update` into `AgentEvent`s and turns `session/request_permission` into `request` events. Steering and compaction depend on the agent; where ACP has no equivalent, `steer` throws `SteerRejectedError`.

## Development

```sh
npm test            # unit tests with fake transports
npm run typecheck
AGENT_ENGINES_LIVE=1 npm run test:live   # real turns on cheap models, in a /tmp scratch dir
```

The live tests run a steered turn, an interrupted turn, a resume, a compaction and a delete on each runtime, plus a Claude question round trip. Override the models with `AGENT_ENGINES_CLAUDE_MODEL` and `AGENT_ENGINES_CODEX_MODEL`.

## Licence

MIT. See [LICENSE](LICENSE).

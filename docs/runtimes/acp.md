# ACP agents

`AcpEngine` drives any agent that speaks [Agent Client Protocol](https://agentclientprotocol.com) version 1 over stdio. It starts one agent process per engine and opens a session per thread.

```ts
import { ACP_AGENTS, createEngine } from "agent-engines";

const opencode = createEngine("acp", ACP_AGENTS.opencode);
const gemini = createEngine("acp", ACP_AGENTS.gemini);
const custom = createEngine("acp", { command: "my-agent", args: ["--acp"] });
```

What it can do comes from the agent's `initialize` answer, so `capabilities()` differs from agent to agent. `ACP_AGENTS` has the commands for OpenCode (`opencode acp`) and Gemini CLI (`gemini --acp`).

## What's different

- **No steering.** ACP has no steering, so `steer` throws `SteerRejectedError`. There is also no compaction, rewind or structured output.
- **Permissions.** Requests surface as `request` events. `access: "full"` allows each one once without asking, `read-only` refuses, and `accept-edits` allows edits and asks about the rest. ACP has no `auto` level.
- **Model and effort.** `model` and `effort` set the session's `model` and `thought_level` options. `fastMode` is ignored.
- **Session settings.** `thread.settings()` lists every option the agent offers, choices and on/off toggles, and `setSetting(id, value)` changes one. A change the agent makes itself arrives as `settings.updated`.
- **Resuming** loads the session, which replays its history into `history()`.
- **Probing.** `models()` and `commands()` open a session in a temporary folder when no thread is open, and the agent may keep it in its own list.
- **Files and terminals** stay with the agent. The engine doesn't offer the client file system or terminal.
- **Updates.** ACP agents report whether their command is there, and `updateRuntime()` throws `UnsupportedFeatureError`.

## Questions

Some agents, such as Antigravity, ask questions through permission requests. A request with two or more options, all `allow_once`, a title, and no tool kind, input, name, locations or content is a `question` at every access level. The same rule checks the earlier tool announcement. Its pending placeholder produces no `tool.*` events; the question and answer appear as messages in live `history()`. A call already announced as running keeps its tool events paired.

An exact option label returns that option ID. Duplicate labels get a unique suffix so every option remains selectable. An empty answer declines. During a running turn, `allowOther` and `multiSelect` are true: free text or several labels decline the option request, wait for the prompt to finish, and go as the next prompt within the same turn. The interim agent text is hidden. This is a prompt fallback, not native structured multi-select: Antigravity discards its multi-select flag and sends several questions as sequential requests. The agent can continue after the declined request before receiving the words. Outside a running turn, only one option can be returned. Interrupting discards queued answers and cancels permission requests that arrive while the prompt is stopping.

Requests with a reject option or tool data remain approvals because their intent is ambiguous. Agents needing several fields or structured multi-select can use `elicitation`, which preserves the schema and answers at every access level.

A pending tool call that names no operation is held back until a request, a patch or the end of the turn shows it is a tool, so its `tool.started` can come later than the agent announced it.

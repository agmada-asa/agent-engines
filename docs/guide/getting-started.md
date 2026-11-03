# Getting started

## Install

Requires Node 22 or later. ESM only.

```sh
npm install agent-engines
```

It also works as a git or local `file:` dependency; `prepare` builds `dist/`.

Each runtime has its own requirement:

- **Codex** needs the `codex` CLI on `PATH`, or its path passed as `executable`.
- **Claude** uses the Claude Code binary the SDK bundles, unless you pass `executable`.
- **ACP agents** need their command. See [ACP agents](/runtimes/acp).

## Run a turn

```ts
import { createEngine } from "agent-engines";

const engine = createEngine("claude"); // or "codex"

const ready = await engine.availability();
if (!ready.ready) throw new Error(ready.message);

const thread = await engine.startThread({
  cwd: "/path/to/workspace",
  model: "haiku",
  effort: "low",
  access: "ask",
  mcpServers: { notes: { command: "node", args: ["notes-mcp.js"] } },
});

const turn = thread.run("Tidy the README.");
for await (const event of turn) {
  if (event.type === "text.delta") process.stdout.write(event.delta);
  if (event.type === "request" && event.request.kind === "approval") {
    await event.request.respond({ decision: "allow" });
  }
}
const result = await turn.result; // { status: "completed" | "interrupted" | "failed", text, usage, error }

// Save thread.id. Later, in the same cwd:
const again = await engine.resumeThread(thread.id, { cwd: "/path/to/workspace" });
```

`createEngine` starts nothing until first use. `turn.result` never rejects: a failure comes back as `status: "failed"` with an `error`.

## Control a running turn

- `turn.steer("…")` adds a message to a running turn.
- `turn.interrupt()` stops it.
- `thread.compact()` compacts the context as a turn of its own.
- `engine.deleteThread(id, { cwd })` removes what the runtime keeps of a thread on disk, subagents included.

## Use an ACP agent

An ACP agent needs its command:

```ts
import { ACP_AGENTS, createEngine } from "agent-engines";

const opencode = createEngine("acp", ACP_AGENTS.opencode);
const custom = createEngine("acp", { command: "my-agent", args: ["--acp"] });
```

## Check what a runtime can do

Runtimes differ, so every engine has every method, and `capabilities()` says which ones work. A method the runtime can't do throws `UnsupportedFeatureError`.

```ts
const capabilities = await engine.capabilities();
if (capabilities.goals) await thread.setGoal("Get the test suite passing");
```

See the [comparison of runtimes](/runtimes/capabilities).

## What it leaves to you

agent-engines covers provider mechanics only. Which tools an agent may use, who approves what, retries, job leases and UI all stay in your app. Restrictive settings are available as [presets](/reference/api#presets) you opt into, not defaults.

## Next steps

- [Sign-in and billing](/guide/sign-in), especially if you're building for other people
- [Events](/guide/events), for showing work as it happens
- [Thread options](/reference/thread-options), for everything `startThread` takes

# agent-engines

[![npm](https://img.shields.io/npm/v/agent-engines)](https://www.npmjs.com/package/agent-engines)
[![Runtimes](https://github.com/agmada-asa/agent-engines/actions/workflows/runtimes.yml/badge.svg)](https://github.com/agmada-asa/agent-engines/actions/workflows/runtimes.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

**One TypeScript API for Codex, Claude and any agent that speaks ACP.**

Every coding agent has its own interface. Codex has a JSON-RPC app-server, Claude has the Agent SDK, and others use the Agent Client Protocol. agent-engines puts them behind one set of threads, turns and events, so your app can support several agents, or move between them, without a separate integration for each.

**[Read the documentation](https://agmada-asa.github.io/agent-engines/)**

```ts
import { createEngine } from "agent-engines";

const engine = createEngine("claude"); // or "codex"

const thread = await engine.startThread({ cwd: "/path/to/project", model: "haiku" });
const turn = thread.run("Summarise this repository.");

for await (const event of turn) {
  if (event.type === "text.delta") process.stdout.write(event.delta);
}
```

## What you get

- **Threads and turns.** Start, resume, fork and rewind conversations. Steer or interrupt a turn while it runs.
- **One event stream.** Text, reasoning, tool calls, file diffs, plans, subagents and usage all arrive in the same shape.
- **Approvals as events.** Permission requests and questions from the agent reach your code to answer however you like.
- **Plan mode, structured output and code review**, wherever the runtime supports them.
- **Portable conversations.** Export a conversation from one runtime and continue it on another.
- **Runtime management.** Check versions, update the CLIs and read plan limits without spending a turn.
- **Codex speed tiers.** List the account's available tiers and request one explicitly, including Ultrafast. [Requested and accepted settings](https://agmada-asa.github.io/agent-engines/guide/models#requested-and-accepted-tiers) stay distinct from inference confirmation.
- **Honest about differences.** `capabilities()` says what a runtime can do, and a method it can't run throws an error rather than quietly doing something else.

## Supported runtimes

| Runtime | How it connects | What it needs |
| --- | --- | --- |
| **Codex** | `codex app-server` over stdio | The `codex` CLI |
| **Claude** | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Nothing extra; the SDK bundles Claude Code |
| **ACP agents** | [Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio | The agent's command, such as `opencode acp` or `gemini --acp` |

## Install

Requires Node 22 or later. ESM only.

```sh
npm install agent-engines
```

Next, follow [Getting started](https://agmada-asa.github.io/agent-engines/guide/getting-started).

## What it leaves to you

agent-engines covers provider mechanics only. Which tools an agent may use, who approves what, retries, job queues and UI all stay in your app. Restrictive settings are available as presets you opt into, not defaults.

## Sign-in and billing

By default it uses the sign-ins from `codex login` and `claude`, and refuses to run on an API key, so turns are never billed per token by accident. Set `requireSubscription: false` to allow API keys.

**If you're building something for other people, read [Sign-in and billing](https://agmada-asa.github.io/agent-engines/guide/sign-in) first:** providers set their own terms on using subscription logins in third-party products, and those terms aren't always clear.

## Project status

agent-engines is pre-1.0, so the API may change between minor versions. A [weekly check](.github/workflows/runtimes.yml) runs it against the latest Codex and Claude Code releases. Bugs and requests go in [GitHub Issues](https://github.com/agmada-asa/agent-engines/issues).

This is an independent project, not affiliated with or endorsed by OpenAI, Anthropic or the ACP project.

## Licence

[MIT](LICENSE)

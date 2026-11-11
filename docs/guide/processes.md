# Processes and failures

## How runtimes run

- **One Codex child per engine.** All Codex threads share one `codex app-server`. If it exits, running turns fail with a `connection` error, and the next call starts a new one and resumes the thread.
- **One Claude Code process per thread.** It stays up while the thread is open, so close threads you're not using.
- **One ACP agent process per engine**, shared by its threads, like Codex.
- **Agents are children of your process.** If your process exits, running turns stop. Resume the thread, check `lastTurn()` and send again.

## When a turn fails

A failed turn has an `error.kind`.

- `usage-limit` and `rate-limit` come with `resetsAt` when the runtime says, so an app can try again then. A transient overload doesn't inherit an unrelated subscription reset time.
- `connection` means the runtime couldn't be reached or stopped answering: a network failure, or a Codex app-server that didn't reply in time.
- `auth` means the runtime isn't signed in, so an app can offer a sign-in. `model` means the model asked for isn't available, or the runtime answered with another one.
- Authentication and context errors stay distinct, even if an earlier usage report was rejected.

## Who handles recovery

The engine restores runtime connections and thread handles. Your app decides whether and when to retry interrupted work, persists pending retries and cancels them when the user stops.

## Errors

Errors extend `AgentEngineError`. `UnsupportedFeatureError` means the runtime can't do what you asked. See the [full list](/reference/api#errors).

## Known warning

With `access: "full"` the Claude SDK prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning. It's harmless: AskUserQuestion still reaches `canUseTool` and surfaces as a `request`, and a live test covers this.

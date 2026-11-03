# Events

A turn is an async iterable of `AgentEvent`s. `thread.subscribe()` sees every event on the thread, including turns the agent starts by itself, as Claude does when a background subagent reports back.

## All event types

| Area | Events |
| --- | --- |
| Turn | `turn.started`, `turn.completed`, `turn.failed` |
| Text | `text.delta`, `text.done`, `reasoning.delta`, `reasoning.done` |
| Tools | `tool.started`, `tool.output.delta`, `tool.progress`, `tool.completed` |
| Files | `file.changed`, `diff.updated` |
| Plans | `plan.updated`, `plan.proposal.delta`, `plan.proposal.done` |
| Background work | `status`, `task.started`, `task.progress`, `task.ended`, `subagent.started`, `subagent.ended` |
| Requests | `request`, `request.resolved` |
| Usage and models | `usage`, `rate-limit`, `compacted`, `model.rerouted`, `model.confirmed`, `service-tier.updated` |
| Runtime | `notice`, `hook.started`, `hook.completed`, `goal.updated`, `mcp.status`, `thread.renamed`, `prompt.suggestion`, `realtime.*` |

`engine.subscribe()` gets the events that belong to no thread: `account.changed` and `notice` (a config warning, a deprecation). Only Codex sends these today. Claude and ACP engines accept a listener, but it never fires.

The union grows in minor releases. A `switch` on `event.type` should have a default branch rather than an exhaustive check that fails to compile when a new member arrives.

Events from a subagent carry its `agentId`.

## Requests

A `request` is an approval, a question (Claude's AskUserQuestion, Codex's user-input request, an ACP agent's multiple-choice question) or an MCP elicitation. Call its `respond` once. An unanswered request is cancelled when the turn ends.

A Codex file-change approval carries the proposed `changes`, with diffs, so the user can review them before allowing.

## File changes

`file.changed` lists the files one tool call changed, from the main agent or a subagent (tagged with its `agentId`): Codex's `apply_patch` edits, and Claude's Edit, MultiEdit, Write and NotebookEdit.

Each `diff` is unified hunks with no `---`/`+++` header, the same from both runtimes. A new file is all `+` lines, a deleted one all `-`, and a Codex move names the new path in `movedTo`. Neither runtime reports files a shell command writes.

## Text phases

Codex marks each agent message's `phase` on `text.delta` and `text.done`: `commentary` for a progress note between tool calls, `answer` for the reply. Claude's text events have no phase. A turn's result text is never a progress note.

## Live progress

These events are for showing work as it happens. None of them changes a turn's result: `tool.completed` still carries the whole output and `turn.completed` the reply.

| Event | Codex | Claude |
| --- | --- | --- |
| `tool.output.delta` | Command output as it streams | Not sent; the SDK doesn't stream command output |
| `tool.progress` | MCP tool progress `message` | `elapsedSeconds` of a running tool |
| `diff.updated` | The turn's whole unified diff so far, replacing the last one | Not sent; use `file.changed` |
| `plan.updated` | The checklist, whole each time, with an optional `explanation` | Each TodoWrite list, with `itemId` of the call |
| `plan.proposal.delta` / `.done` | A plan streamed in plan mode; `.done` has the final text | `.done` with the plan when Claude asks to leave plan mode |
| `status` | From the thread status: `working`, `waiting` (with `waitingOn`), `idle`; also `compacting` and `retrying` | `working`, `compacting`, `retrying` with attempt and delay |
| `task.started` / `task.ended` | Not sent | Background shells, monitors, workflows and MCP tasks |
| `task.progress` | Not sent | The same tasks, and subagents (`taskId` is the `subagentId`) |

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

### Limits worth knowing

- `status` is a hint for a status line, not a turn lifecycle. Use `turn.completed` and `turn.failed` for that. A Codex `idle` usually arrives after `turn.completed`, so it reaches `thread.subscribe` but not the turn's iterator.
- Claude reports `idle` and `waiting` only through session-state events, which the SDK sends when a session opts in. The engine doesn't opt in, so from Claude expect `working`, `compacting` and `retrying`. A pending `request` is the sign it's waiting.
- `retrying` means the runtime will try the model request again. The turn has not failed.
- When a finished subagent begins another turn, it reports `subagent.started` again with the same `subagentId`, then its own `subagent.ended`. Queuing a Codex message without waking the subagent doesn't start it. From Claude, `prompt` on that second start is the new message, and older run IDs can't change the current run.
- A task a subagent launched carries that subagent's `agentId`. `task.ended` needs the `task.started` from the same thread handle, so a task begun before a resume doesn't end on the new handle.

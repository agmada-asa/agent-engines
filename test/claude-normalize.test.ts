/** @file Claude SDK message normalisation, from recorded message shapes. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeNormalizer, claudeRateLimit, claudeTranscript, claudeUsage, classifyClaudeError } from "../src/claude/normalize.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const S = "session-1";
const msg = (value: Record<string, unknown>) => value as unknown as SDKMessage;

test("network and service failures remain recoverable without masking sign-in errors", () => {
  const rejected = { status: "rejected" as const, resetsAt: new Date("2026-10-22T13:00:00Z") };
  for (const message of ["fetch failed", "API Error: Can't reach the API server (ENOTFOUND)", "Request timed out", "API Error: 503 Service Unavailable", "stream disconnected before completion", "socket hang up"]) {
    assert.equal(classifyClaudeError(message, undefined, rejected).kind, "connection", message);
  }
  assert.equal(classifyClaudeError("Please run /login", "authentication_failed", rejected).kind, "auth");
  assert.equal(classifyClaudeError("Prompt is too long", undefined, rejected).kind, "context-window");
  assert.deepEqual(classifyClaudeError("Overloaded", "overloaded", rejected), { kind: "rate-limit", message: "Overloaded" });
  assert.deepEqual(classifyClaudeError("You hit your limit", "rate_limit", undefined), { kind: "usage-limit", message: "You hit your limit" });
});

test("a previous turn's rejected allowance does not classify the next turn's failure", () => {
  const n = new ClaudeNormalizer(S);
  n.normalize(msg({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1800000000 } }), "t1");
  n.startTurn();
  assert.equal(classifyClaudeError("Tool failed", n.assistantError, n.lastLimit).kind, "other");
});

test("streamed text and the whole message share an item ID", () => {
  const n = new ClaudeNormalizer(S);
  assert.deepEqual(n.normalize(msg({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } }), "t"), []);
  n.normalize(msg({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }), "t");
  n.normalize(msg({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 1, content_block: { type: "text" } } }), "t");
  const thinking = n.normalize(msg({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }), "t");
  const text = n.normalize(msg({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } } }), "t");
  assert.deepEqual(thinking, [{ threadId: S, turnId: "t", type: "reasoning.delta", itemId: "m1:thinking:0", delta: "hmm" }]);
  assert.deepEqual(text, [{ threadId: S, turnId: "t", type: "text.delta", itemId: "m1:text:0", delta: "Hi" }]);
  // Streamed assistant messages arrive one block at a time.
  const wholeThinking = n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "thinking", thinking: "hmm" }] } }), "t");
  const wholeText = n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Hi" }] } }), "t");
  assert.equal((wholeThinking[0] as any).itemId, "m1:thinking:0");
  assert.deepEqual(wholeText, [{ threadId: S, turnId: "t", type: "text.done", itemId: "m1:text:0", text: "Hi" }]);
});

test("tool use and results, with file changes from Edit and Write", () => {
  const n = new ClaudeNormalizer(S);
  const started = n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [
    { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
    { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/tmp/new.txt", content: "x" } },
    { type: "tool_use", id: "p1", name: "mcp__notes__search", input: { query: "x" } },
  ] } }), "t");
  assert.deepEqual(started.map((event: any) => event.tool), [
    { kind: "command", name: "Bash", input: { command: "ls" } },
    { kind: "builtin", name: "Write", input: { file_path: "/tmp/new.txt", content: "x" } },
    { kind: "mcp", name: "mcp__notes__search", server: "notes", input: { query: "x" } },
  ]);
  const bash = n.normalize(msg({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "a\nb", is_error: false }] } }), "t");
  assert.deepEqual(bash, [{ threadId: S, turnId: "t", type: "tool.completed", itemId: "b1", tool: { kind: "command", name: "Bash", input: { command: "ls" } }, output: "a\nb", isError: false }]);
  const write = n.normalize(msg({ type: "user", parent_tool_use_id: null, tool_use_result: { type: "create", filePath: "/tmp/new.txt", content: "x\ny\n", structuredPatch: [] }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: [{ type: "text", text: "File created" }] }] } }), "t");
  assert.equal(write[0].type, "tool.completed");
  assert.deepEqual(write[1], { threadId: S, turnId: "t", type: "file.changed", itemId: "w1", changes: [{ path: "/tmp/new.txt", kind: "add", diff: "@@ -0,0 +1,2 @@\n+x\n+y" }] });
  const failed = n.normalize(msg({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p1", content: "boom", is_error: true }] } }), "t");
  assert.equal((failed[0] as any).isError, true);
});

test("file changes carry unified hunks: edits from the patch, notebooks without one, subagents' tagged", () => {
  const n = new ClaudeNormalizer(S);
  n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [
    { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" } },
    { type: "tool_use", id: "nb", name: "NotebookEdit", input: { notebook_path: "/tmp/n.ipynb", new_source: "x" } },
    { type: "tool_use", id: "task-tool", name: "Agent", input: { prompt: "Fix" } },
  ] } }), "t");
  const edit = n.normalize(msg({ type: "user", parent_tool_use_id: null, tool_use_result: {
    filePath: "/tmp/a.ts", oldString: "a", newString: "b",
    structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" keep", "-a", "+b"] }],
  }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } }), "t");
  assert.deepEqual((edit[1] as any).changes, [{ path: "/tmp/a.ts", kind: "update", diff: "@@ -3,2 +3,2 @@\n keep\n-a\n+b" }]);
  const notebook = n.normalize(msg({ type: "user", parent_tool_use_id: null, tool_use_result: { notebook_path: "/tmp/n.ipynb", new_source: "x" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "nb", content: "ok" }] } }), "t");
  assert.deepEqual((notebook[1] as any).changes, [{ path: "/tmp/n.ipynb", kind: "update" }]);
  n.normalize(msg({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "task-tool", task_type: "local_agent" }), "t");
  n.normalize(msg({ type: "assistant", parent_tool_use_id: "task-tool", message: { id: "sm", content: [{ type: "tool_use", id: "sw", name: "Write", input: { file_path: "/tmp/b.md", content: "hi" } }] } }), "t");
  const inner = n.normalize(msg({ type: "user", parent_tool_use_id: "task-tool", tool_use_result: { type: "create", filePath: "/tmp/b.md", content: "hi" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sw", content: "ok" }] } }), "t");
  assert.deepEqual(inner[1], { threadId: S, turnId: "t", agentId: "agent-1", type: "file.changed", itemId: "sw", changes: [{ path: "/tmp/b.md", kind: "add", diff: "@@ -0,0 +1,1 @@\n+hi" }] });
});

test("subagents: task events and their messages tagged with the task ID", () => {
  const n = new ClaudeNormalizer(S);
  n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "tool_use", id: "task-tool", name: "Agent", input: { prompt: "Look" } }] } }), "t");
  const started = n.normalize(msg({ type: "system", subtype: "task_started", task_id: "agent-7", tool_use_id: "task-tool", description: "Look around", task_type: "local_agent", prompt: "Look" }), "t");
  assert.deepEqual(started, [{ threadId: S, turnId: "t", type: "subagent.started", subagentId: "agent-7", description: "Look around", prompt: "Look" }]);
  const inner = n.normalize(msg({ type: "assistant", parent_tool_use_id: "task-tool", message: { id: "sm", content: [{ type: "text", text: "found it" }] } }), "t");
  assert.deepEqual(inner, [{ threadId: S, turnId: "t", agentId: "agent-7", type: "text.done", itemId: "sm:text:0", text: "found it" }]);
  const tagged = n.normalize(msg({ type: "assistant", parent_tool_use_id: null, agent_id: "agent-7", message: { id: "sm2", content: [{ type: "text", text: "x" }] } }), "t");
  assert.equal(tagged[0].agentId, "agent-7");
  const shell = n.normalize(msg({ type: "system", subtype: "task_started", task_id: "sh", description: "npm test", task_type: "local_bash" }), "t");
  // A shell is a task, not a subagent.
  assert.deepEqual(shell.map((event) => event.type), ["task.started"]);
  const ended = n.normalize(msg({ type: "system", subtype: "task_notification", task_id: "agent-7", status: "completed", summary: "Found the file", output_file: "" }), "t");
  assert.deepEqual(ended, [{ threadId: S, turnId: "t", type: "subagent.ended", subagentId: "agent-7", status: "completed", summary: "Found the file" }]);
  assert.deepEqual(n.subagentIds, ["agent-7"]);
});

test("compaction, rate limits and refusal fallbacks", () => {
  const n = new ClaudeNormalizer(S);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 9000, post_tokens: 1200 } }), "t"), [
    { threadId: S, turnId: "t", type: "compacted", beforeTokens: 9000, afterTokens: 1200 },
  ]);
  const limit = n.normalize(msg({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1800000000, rateLimitType: "five_hour", utilization: 1 } }), "t");
  assert.deepEqual((limit[0] as any).limit, { status: "rejected", window: "five_hour", usedPercent: 100, resetsAt: new Date(1800000000 * 1000) });
  assert.equal(n.lastLimit?.status, "rejected");
  const fallback = n.normalize(msg({ type: "system", subtype: "model_refusal_fallback", original_model: "a", fallback_model: "b", trigger: "refusal", direction: "retry", request_id: null, content: "" }), "t");
  assert.deepEqual(fallback[0], { threadId: S, turnId: "t", type: "model.rerouted", from: "a", to: "b" });
});

test("classifyClaudeError", () => {
  const rejected = claudeRateLimit({ status: "rejected", resetsAt: 1800000000 });
  assert.deepEqual(classifyClaudeError("Claude AI usage limit reached", undefined, rejected), { kind: "usage-limit", message: "Claude AI usage limit reached", resetsAt: new Date(1800000000 * 1000) });
  assert.equal(classifyClaudeError("You've hit your limit · resets 3pm", undefined, undefined).kind, "usage-limit");
  assert.equal(classifyClaudeError("Not logged in · Please run /login", "authentication_failed", undefined).kind, "auth");
  assert.equal(classifyClaudeError("Prompt is too long", undefined, undefined).kind, "context-window");
  assert.equal(classifyClaudeError("API Error: 529 overloaded", "overloaded", undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("something", undefined, claudeRateLimit({ status: "allowed" })).kind, "other");
  assert.equal(classifyClaudeError("5-hour limit reached ∙ resets 3pm", undefined, undefined).kind, "usage-limit");
  assert.equal(classifyClaudeError("Weekly limit reached", undefined, undefined).kind, "usage-limit");
});

test("text that only mentions a limit or a reset is not a spent allowance", () => {
  const allowed = claudeRateLimit({ status: "allowed" });
  assert.equal(classifyClaudeError("GitHub API rate limit reached for user", undefined, allowed).kind, "rate-limit");
  assert.equal(classifyClaudeError("API Error: 429 Too Many Requests", undefined, undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("Recursion limit reached in parser", undefined, allowed).kind, "other");
  assert.equal(classifyClaudeError("The cache resets at midnight; tool failed", undefined, undefined).kind, "other");
});

test("Claude's rate_limit code also covers transient 429s and capacity errors", () => {
  const transient = "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
  assert.equal(classifyClaudeError(transient, "rate_limit", undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError(transient, undefined, undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("Request rejected (429)", "rate_limit", undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("Opus is experiencing high load. Switch to Sonnet.", "rate_limit", undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("Unknown provider message", "rate_limit", undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("You've hit your rate limit", "rate_limit", undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("You've reached your rate limit", undefined, undefined).kind, "rate-limit");
  assert.equal(classifyClaudeError("Approaching your usage limit", undefined, undefined).kind, "other");
});

test("Claude's current allowance messages are usage limits even without the code", () => {
  for (const text of [
    "You've hit your weekly limit · resets Nov 1",
    "You've reached your usage limit",
    "You're out of usage credits",
    "Your org is out of usage · contact your admin",
    "Your seat type doesn't include usage credits",
    "Your usage allocation has been disabled by your admin",
    "You're out of extra usage",
    "API Error: Claude AI usage limit reached",
  ]) {
    assert.equal(classifyClaudeError(text, undefined, undefined).kind, "usage-limit", text);
  }
});

test("explicit Claude failures take precedence over an allowance report", () => {
  const rejected = claudeRateLimit({ status: "rejected", resetsAt: 1800000000 });
  for (const [text, code, kind] of [
    ["Not logged in", "authentication_failed", "auth"],
    ["Prompt is too long", undefined, "context-window"],
    ["API Error: 529 overloaded", "overloaded", "rate-limit"],
    ["fetch failed", undefined, "connection"],
  ]) {
    assert.deepEqual(classifyClaudeError(text!, code, rejected), { kind, message: text });
  }
  assert.equal(classifyClaudeError("API Error: 429 Too Many Requests", "rate_limit", rejected).kind, "usage-limit");
});

test("claudeUsage sums models and keeps the context window", () => {
  assert.deepEqual(claudeUsage({
    a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 1, thinkingTokens: 3 },
    b: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 1000000, maxOutputTokens: 1 },
  }), { inputTokens: 14, cachedInputTokens: 2, outputTokens: 6, reasoningOutputTokens: 3, totalTokens: 20, contextWindow: 1000000 });
  assert.equal(claudeUsage({}), undefined);
});

test("claudeTranscript pairs tool calls with results", () => {
  const entries = claudeTranscript([
    { type: "user", message: { content: "Brief" } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "plan" }, { type: "tool_use", id: "x", name: "Read", input: { file_path: "/a" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "contents", is_error: false }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Report" }] } },
  ]);
  assert.deepEqual(entries, [
    { kind: "message", role: "user", text: "Brief" },
    { kind: "reasoning", text: "plan" },
    { kind: "tool", tool: { kind: "builtin", name: "Read", input: { file_path: "/a" } }, output: "contents" },
    { kind: "message", role: "assistant", text: "Report" },
  ]);
});

test("tool progress, including a subagent's", () => {
  const n = new ClaudeNormalizer(S);
  assert.deepEqual(n.normalize(msg({ type: "tool_progress", tool_use_id: "b1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 12 }), "t"), [
    { threadId: S, turnId: "t", type: "tool.progress", itemId: "b1", elapsedSeconds: 12 },
  ]);
  n.normalize(msg({ type: "system", subtype: "task_started", task_id: "task-a", tool_use_id: "agent-call", description: "Explore", task_type: "local_agent" }), "t");
  const nested = n.normalize(msg({ type: "tool_progress", tool_use_id: "b2", tool_name: "Bash", parent_tool_use_id: "agent-call", elapsed_time_seconds: 3 }), "t");
  assert.equal(nested[0].agentId, "task-a");
});

test("TodoWrite becomes a plan update alongside its tool call", () => {
  const n = new ClaudeNormalizer(S);
  const events = n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{
    type: "tool_use", id: "todo1", name: "TodoWrite", input: { todos: [
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Run tests", status: "pending", activeForm: "Running tests" },
    ] },
  }] } }), "t");
  assert.deepEqual(events.map((event) => event.type), ["tool.started", "plan.updated"]);
  assert.deepEqual(events[1], {
    threadId: S, turnId: "t", type: "plan.updated", itemId: "todo1",
    steps: [{ step: "Read the code", status: "completed" }, { step: "Fix the bug", status: "in-progress" }, { step: "Run tests", status: "pending" }],
  });
  const malformed = n.normalize(msg({ type: "assistant", parent_tool_use_id: null, message: { id: "m2", content: [{ type: "tool_use", id: "todo2", name: "TodoWrite", input: {} }] } }), "t");
  assert.deepEqual(malformed.map((event) => event.type), ["tool.started"]);
});

test("background tasks that are not subagents get their own lifecycle", () => {
  const n = new ClaudeNormalizer(S);
  const started = n.normalize(msg({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "b1", description: "npm run build", task_type: "local_bash", is_backgrounded: true }), "t");
  assert.deepEqual(started, [{ threadId: S, turnId: "t", type: "task.started", taskId: "bash-1", kind: "shell", description: "npm run build", itemId: "b1", background: true }]);
  assert.deepEqual(n.subagentIds, []);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: { status: "running" } }), "t"), [
    { threadId: S, turnId: "t", type: "task.progress", taskId: "bash-1", status: "running" },
  ]);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "task_updated", task_id: "bash-1", patch: {} }), "t"), []);
  const ended = n.normalize(msg({ type: "system", subtype: "task_notification", task_id: "bash-1", status: "failed", output_file: "/tmp/out.log", summary: "Build failed" }), "");
  assert.deepEqual(ended, [{ threadId: S, turnId: "", type: "task.ended", taskId: "bash-1", status: "failed", summary: "Build failed", outputFile: "/tmp/out.log" }]);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "task_notification", task_id: "bash-1", status: "failed", output_file: "", summary: "" }), ""), []);
  // Unknown task types keep their own name.
  assert.equal((n.normalize(msg({ type: "system", subtype: "task_started", task_id: "w", description: "watch", task_type: "monitor" }), "t")[0] as any).kind, "monitor");
});

test("subagents keep subagent events, report progress as tasks, and own the tasks they launch", () => {
  const n = new ClaudeNormalizer(S);
  const started = n.normalize(msg({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "call-1", description: "Explore", task_type: "local_agent", subagent_type: "Explore" }), "t");
  assert.deepEqual(started.map((event) => event.type), ["subagent.started"]);
  const progress = n.normalize(msg({
    type: "system", subtype: "task_progress", task_id: "agent-1", description: "Explore", summary: "Reading the parser",
    last_tool_name: "Grep", usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 9000 },
  }), "t");
  assert.deepEqual(progress, [{
    threadId: S, turnId: "t", type: "task.progress", taskId: "agent-1", description: "Explore", summary: "Reading the parser",
    lastTool: "Grep", usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 },
  }]);
  const child = n.normalize(msg({ type: "system", subtype: "task_started", task_id: "bash-2", description: "tests", task_type: "local_bash", parent_task_id: "agent-1" }), "t");
  assert.equal(child[0].agentId, "agent-1");
  assert.equal(n.normalize(msg({ type: "system", subtype: "task_updated", task_id: "bash-2", patch: { status: "running" } }), "t")[0].agentId, "agent-1");
  assert.equal(n.normalize(msg({ type: "system", subtype: "task_progress", task_id: "bash-2", description: "tests" }), "t")[0].agentId, "agent-1");
  assert.equal(n.normalize(msg({ type: "system", subtype: "task_notification", task_id: "bash-2", status: "completed" }), "t")[0].agentId, "agent-1");
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "killed", is_backgrounded: true } }), "t"), [
    { threadId: S, turnId: "t", type: "task.progress", taskId: "agent-1", status: "stopped", background: true },
  ]);
  const ended = n.normalize(msg({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed", output_file: "", summary: "Done" }), "t");
  assert.deepEqual(ended.map((event) => event.type), ["subagent.ended"]);
});

test("runtime status, retries and session state", () => {
  const n = new ClaudeNormalizer(S);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "status", status: "requesting" }), "t"), [{ threadId: S, turnId: "t", type: "status", status: { state: "working" } }]);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "status", status: "compacting" }), "t")[0], { threadId: S, turnId: "t", type: "status", status: { state: "compacting" } });
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "status", status: null }), "t"), []);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" }), "t"), [{
    threadId: S, turnId: "t", type: "status", status: { state: "retrying", retry: { attempt: 2, maxAttempts: 10, delayMs: 4000, message: "overloaded (HTTP 529)" } },
  }]);
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "session_state_changed", state: "requires_action" }), "t")[0], { threadId: S, turnId: "t", type: "status", status: { state: "waiting" } });
  assert.deepEqual(n.normalize(msg({ type: "system", subtype: "session_state_changed", state: "idle" }), "")[0], { threadId: S, turnId: "", type: "status", status: { state: "idle" } });
});

/** @file Codex notification and server-request normalisation, from recorded shapes. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexNormalizer, classifyCodexError, codexRateLimits, codexRequest } from "../src/codex/normalize.ts";

const T = "thread-1";

function normalizer(): CodexNormalizer {
  const n = new CodexNormalizer(T);
  n.normalize("turn/started", { threadId: T, turn: { id: "turn-1", items: [], status: "inProgress" } });
  return n;
}

test("text and reasoning deltas, and the final message", () => {
  const n = normalizer();
  assert.deepEqual(n.normalize("item/agentMessage/delta", { threadId: T, turnId: "turn-1", itemId: "m1", delta: "Hel" }), [
    { threadId: T, turnId: "turn-1", type: "text.delta", itemId: "m1", delta: "Hel" },
  ]);
  assert.equal(n.normalize("item/reasoning/summaryTextDelta", { threadId: T, turnId: "turn-1", itemId: "r1", delta: "thinking", summaryIndex: 0 })[0].type, "reasoning.delta");
  const done = n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "Hello" } });
  assert.deepEqual(done, [{ threadId: T, turnId: "turn-1", type: "text.done", itemId: "m1", text: "Hello" }]);
  const reasoning = n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "reasoning", id: "r1", summary: ["a", "b"], content: [] } });
  assert.deepEqual(reasoning[0], { threadId: T, turnId: "turn-1", type: "reasoning.done", itemId: "r1", text: "a\n\nb" });
  const completed = n.normalize("turn/completed", { threadId: T, turn: { id: "turn-1", status: "completed", items: [], error: null } });
  assert.deepEqual(completed, [{ threadId: T, turnId: "turn-1", type: "turn.completed", status: "completed", text: "Hello" }]);
});

test("ignores other threads", () => {
  const n = normalizer();
  assert.deepEqual(n.normalize("item/agentMessage/delta", { threadId: "other", turnId: "x", itemId: "m", delta: "no" }), []);
});

test("tool calls: commands, MCP tools and web search", () => {
  const n = normalizer();
  const started = n.normalize("item/started", {
    threadId: T, turnId: "turn-1",
    item: { type: "commandExecution", id: "c1", command: "ls -la", cwd: "/tmp", status: "inProgress", aggregatedOutput: null, exitCode: null },
  });
  assert.deepEqual(started, [{ threadId: T, turnId: "turn-1", type: "tool.started", itemId: "c1", tool: { kind: "command", name: "shell", input: { command: "ls -la", cwd: "/tmp" } } }]);
  const finished = n.normalize("item/completed", {
    threadId: T, turnId: "turn-1",
    item: { type: "commandExecution", id: "c1", command: "ls -la", cwd: "/tmp", status: "completed", aggregatedOutput: "a\nb", exitCode: 1 },
  });
  assert.equal(finished[0].type, "tool.completed");
  assert.equal((finished[0] as any).output, "a\nb");
  assert.equal((finished[0] as any).isError, true);
  const mcp = n.normalize("item/completed", {
    threadId: T, turnId: "turn-1",
    item: { type: "mcpToolCall", id: "t1", server: "notes", tool: "search", arguments: { q: "x" }, status: "completed", result: { content: [{ type: "text", text: "found" }] }, error: null },
  });
  assert.deepEqual(mcp[0], {
    threadId: T, turnId: "turn-1", type: "tool.completed", itemId: "t1",
    tool: { kind: "mcp", name: "mcp__notes__search", server: "notes", input: { q: "x" } }, output: "found", isError: false,
  });
  const search = n.normalize("item/started", { threadId: T, turnId: "turn-1", item: { type: "webSearch", id: "w1", query: "weather" } });
  assert.equal((search[0] as any).tool.kind, "web-search");
});

test("file changes", () => {
  const n = normalizer();
  const events = n.normalize("item/completed", {
    threadId: T, turnId: "turn-1",
    item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/tmp/a.txt", kind: { type: "add" }, diff: "+hi" }, { path: "/tmp/b.txt", kind: "update", diff: "" }] },
  });
  assert.deepEqual(events, [{
    threadId: T, turnId: "turn-1", type: "file.changed", itemId: "f1",
    changes: [{ path: "/tmp/a.txt", kind: "add", diff: "+hi" }, { path: "/tmp/b.txt", kind: "update" }],
  }]);
  const deleted = n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "fileChange", id: "f2", status: "completed", changes: [{ path: "/x", kind: { type: "delete" }, diff: "" }] } });
  assert.equal((deleted[0] as any).changes[0].kind, "delete");
});

test("collab subagents: spawn, their own events tagged, and their end", () => {
  const n = normalizer();
  const spawn = n.normalize("item/completed", {
    threadId: T, turnId: "turn-1",
    item: { type: "collabAgentToolCall", id: "s1", tool: "spawnAgent", status: "completed", senderThreadId: T, receiverThreadIds: ["child-1"], prompt: "Research X", model: "gpt-6-luna", reasoningEffort: "low", agentsStates: { "child-1": { status: "running", message: null } } },
  });
  assert.equal(spawn[0].type, "tool.completed");
  assert.deepEqual(spawn[1], { threadId: T, turnId: "turn-1", type: "subagent.started", subagentId: "child-1", prompt: "Research X", model: "gpt-6-luna" });
  assert.equal(n.owns("child-1"), true);
  const childText = n.normalize("item/agentMessage/delta", { threadId: "child-1", turnId: "child-turn", itemId: "cm", delta: "working" });
  assert.deepEqual(childText, [{ threadId: T, turnId: "turn-1", agentId: "child-1", type: "text.delta", itemId: "cm", delta: "working" }]);
  // A child's own turn lifecycle does not end the parent's turn.
  assert.deepEqual(n.normalize("turn/completed", { threadId: "child-1", turn: { id: "child-turn", status: "completed", items: [] } }), []);
  const wait = n.normalize("item/completed", {
    threadId: T, turnId: "turn-1",
    item: { type: "collabAgentToolCall", id: "w1", tool: "wait", status: "completed", senderThreadId: T, receiverThreadIds: ["child-1"], prompt: null, model: null, reasoningEffort: null, agentsStates: { "child-1": { status: "completed", message: "Done: X is Y" } } },
  });
  assert.deepEqual(wait[1], { threadId: T, turnId: "turn-1", type: "subagent.ended", subagentId: "child-1", status: "completed", summary: "Done: X is Y" });
  // subAgentActivity for the same agent does not duplicate.
  assert.deepEqual(n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "subAgentActivity", id: "a", kind: "completed", agentThreadId: "child-1", agentPath: "", model: null, reasoningEffort: null } }), []);
  assert.deepEqual(n.subagentIds, ["child-1"]);
});

test("subAgentActivity starts and ends a subagent", () => {
  const n = normalizer();
  const started = n.normalize("item/started", { threadId: T, turnId: "turn-1", item: { type: "subAgentActivity", id: "a1", kind: "started", agentThreadId: "child-2", agentPath: "/a", model: "gpt-6-luna", reasoningEffort: null } });
  assert.deepEqual(started, [{ threadId: T, turnId: "turn-1", type: "subagent.started", subagentId: "child-2", model: "gpt-6-luna" }]);
  const ended = n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "subAgentActivity", id: "a2", kind: "interrupted", agentThreadId: "child-2", agentPath: "/a", model: null, reasoningEffort: null } });
  assert.equal((ended[0] as any).status, "stopped");
});

test("usage, rate limits and a usage-limit failure with its reset time", () => {
  const n = normalizer();
  const usage = n.normalize("thread/tokenUsage/updated", {
    threadId: T, turnId: "turn-1",
    tokenUsage: { total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 }, last: {}, modelContextWindow: 400000 },
  });
  assert.deepEqual((usage[0] as any).usage, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120, contextWindow: 400000 });
  const limits = n.normalize("account/rateLimits/updated", {
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1792673294 }, secondary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1793089658 }, rateLimitReachedType: "primary" },
  });
  assert.equal(limits.length, 2);
  assert.equal((limits[0] as any).limit.status, "rejected");
  assert.equal((limits[1] as any).limit.status, "ok");
  n.normalize("error", { threadId: T, turnId: "turn-1", willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null } });
  const failed = n.normalize("turn/completed", { threadId: T, turn: { id: "turn-1", status: "failed", items: [], error: null } });
  assert.equal(failed[0].type, "turn.failed");
  const error = (failed[0] as any).error;
  assert.equal(error.kind, "usage-limit");
  assert.equal(error.resetsAt.getTime(), 1792673294 * 1000);
  assert.equal((failed[0] as any).usage.totalTokens, 120);
});

test("an interrupted turn completes with status interrupted", () => {
  const n = normalizer();
  const events = n.normalize("turn/completed", { threadId: T, turn: { id: "turn-1", status: "interrupted", items: [], error: null } });
  assert.deepEqual(events, [{ threadId: T, turnId: "turn-1", type: "turn.completed", status: "interrupted", text: "" }]);
});

test("compaction, reroutes and resolved requests", () => {
  const n = normalizer();
  assert.equal(n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "contextCompaction", id: "c" } })[0].type, "compacted");
  assert.deepEqual(n.normalize("model/rerouted", { threadId: T, turnId: "turn-1", fromModel: "a", toModel: "b" })[0], { threadId: T, turnId: "turn-1", type: "model.rerouted", from: "a", to: "b" });
  assert.deepEqual(n.normalize("serverRequest/resolved", { threadId: T, requestId: 7 })[0], { threadId: T, turnId: "turn-1", type: "request.resolved", requestId: "7" });
});

test("classifyCodexError", () => {
  assert.deepEqual(classifyCodexError({ message: "busy", codexErrorInfo: "serverOverloaded" }, [{ status: "rejected", resetsAt: new Date("2026-10-22T13:00:00Z") }]), { kind: "rate-limit", message: "busy" });
  assert.equal(classifyCodexError({ message: "x", codexErrorInfo: "contextWindowExceeded" }).kind, "context-window");
  assert.equal(classifyCodexError({ message: "x", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }).kind, "connection");
  assert.equal(classifyCodexError({ message: "x", codexErrorInfo: "unauthorized" }).kind, "auth");
  assert.equal(classifyCodexError(null).kind, "other");
  assert.deepEqual(codexRateLimits(undefined), []);
});

test("approval requests map decisions to Codex's", async () => {
  const command = codexRequest(5, "item/commandExecution/requestApproval", { threadId: T, turnId: "turn-1", itemId: "c", command: "rm -rf build", cwd: "/repo", reason: "cleanup" })!;
  assert.equal(command.request.kind, "approval");
  assert.equal((command.request as any).action, "command");
  assert.equal((command.request as any).command, "rm -rf build");
  await (command.request as any).respond({ decision: "allow-session" });
  assert.deepEqual(await command.response, { decision: "acceptForSession" });

  const files = codexRequest(6, "item/fileChange/requestApproval", { threadId: T, turnId: "turn-1", itemId: "f" })!;
  files.cancel();
  assert.deepEqual(await files.response, { decision: "cancel" });

  const permissions = codexRequest(7, "item/permissions/requestApproval", { threadId: T, turnId: "turn-1", itemId: "p", cwd: "/repo", reason: null, permissions: { network: { enabled: true }, fileSystem: null } })!;
  await (permissions.request as any).respond({ decision: "allow" });
  assert.deepEqual(await permissions.response, { permissions: { network: { enabled: true } }, scope: "turn" });

  const legacy = codexRequest(8, "execCommandApproval", { command: ["ls"] })!;
  await (legacy.request as any).respond({ decision: "deny" });
  assert.deepEqual(await legacy.response, { decision: "denied" });
});

test("question and elicitation requests", async () => {
  const question = codexRequest("q1", "item/tool/requestUserInput", {
    threadId: T, turnId: "turn-1", itemId: "i", isBlocking: true, autoResolutionMs: null,
    questions: [{ id: "colour", header: "Colour", question: "Which colour?", isOther: true, isSecret: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "Calm" }] }],
  })!;
  const request = question.request as any;
  assert.equal(request.kind, "question");
  assert.deepEqual(request.questions[0], { id: "colour", header: "Colour", question: "Which colour?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "Calm" }], multiSelect: false, allowOther: true, secret: false });
  await request.respond({ colour: ["Blue"] });
  assert.deepEqual(await question.response, { answers: { colour: { answers: ["Blue"] } } });
  // Only the first answer counts.
  await request.respond({ colour: ["Red"] });

  const elicitation = codexRequest(9, "mcpServer/elicitation/request", { threadId: T, turnId: null, serverName: "github", mode: "url", _meta: null, message: "Sign in", url: "https://example.com", elicitationId: "e" })!;
  assert.equal((elicitation.request as any).mode, "url");
  await (elicitation.request as any).respond({ action: "accept" });
  assert.deepEqual(await elicitation.response, { action: "accept", content: null, _meta: null });

  assert.equal(codexRequest(10, "item/tool/call", {}), undefined);
});

test("agent messages carry their phase, and a progress note is not the turn's reply", () => {
  const n = normalizer();
  assert.deepEqual(n.normalize("item/started", { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "", phase: "commentary" } }), []);
  assert.deepEqual(n.normalize("item/agentMessage/delta", { threadId: T, turnId: "turn-1", itemId: "m1", delta: "Looking" }), [
    { threadId: T, turnId: "turn-1", type: "text.delta", itemId: "m1", delta: "Looking", phase: "commentary" },
  ]);
  assert.equal((n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "Looking", phase: "commentary" } })[0] as any).phase, "commentary");
  n.normalize("item/started", { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m2", text: "", phase: "final_answer" } });
  assert.equal((n.normalize("item/agentMessage/delta", { threadId: T, turnId: "turn-1", itemId: "m2", delta: "Done" })[0] as any).phase, "answer");
  n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m2", text: "Done", phase: "final_answer" } });
  // A note after the answer still leaves the answer as the turn's text.
  n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "agentMessage", id: "m3", text: "Tidying up", phase: "commentary" } });
  const completed = n.normalize("turn/completed", { threadId: T, turn: { id: "turn-1", status: "completed", items: [], error: null } });
  assert.equal((completed[0] as any).text, "Done");
  // Without phases, as older Codex sends them, text events leave it out.
  assert.equal("phase" in n.normalize("item/agentMessage/delta", { threadId: T, turnId: "turn-1", itemId: "m4", delta: "x" })[0], false);
});

test("a file-change approval carries the changes its item announced", async () => {
  const n = normalizer();
  assert.deepEqual(n.normalize("item/started", {
    threadId: T, turnId: "turn-1",
    item: { type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "/tmp/a.txt", kind: { type: "update" }, diff: "-a\n+b" }] },
  }), []);
  const files = codexRequest(11, "item/fileChange/requestApproval", { threadId: T, turnId: "turn-1", itemId: "f1" }, { proposedChanges: n.proposedChanges("f1") })!;
  assert.deepEqual((files.request as any).changes, [{ path: "/tmp/a.txt", kind: "update", diff: "-a\n+b" }]);
  // A command approval never carries file changes.
  const command = codexRequest(12, "item/commandExecution/requestApproval", { threadId: T, turnId: "turn-1", itemId: "c", command: "ls" }, { proposedChanges: [] })!;
  assert.equal("changes" in command.request, false);
  n.normalize("item/completed", { threadId: T, turnId: "turn-1", item: { type: "fileChange", id: "f1", status: "completed", changes: [] } });
  assert.equal(n.proposedChanges("f1"), undefined);
});

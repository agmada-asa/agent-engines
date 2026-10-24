/**
 * @file The Claude engine's history, fork and rewind, modes and access per
 * turn, structured output, documents, limits, hooks, notices, MCP controls and
 * prewarmed threads, against the scripted fake SDK.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeEngine } from "../src/claude/engine.ts";
import { UnsupportedFeatureError } from "../src/errors.ts";
import type { AgentEvent } from "../src/types.ts";
import { until } from "./fake-app-server.ts";
import { fakeClaudeSdk, replyMessages, type FakeQuery } from "./fake-claude-sdk.ts";

/** A stored session: two turns, each a prompt and a reply, with a tool call in the first. */
function storedSession() {
  const entry = (type: string, uuid: string, content: unknown) => ({ type, uuid, session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content } });
  return [
    entry("user", "turn-a", "Add a test"),
    entry("assistant", "a1", [{ type: "tool_use", id: "tu", name: "Write", input: { file_path: "/tmp/a.test.ts" } }]),
    entry("user", "r1", [{ type: "tool_result", tool_use_id: "tu", content: "written" }]),
    entry("assistant", "a2", [{ type: "text", text: "Added it." }]),
    entry("user", "turn-b", [{ type: "text", text: "Thanks" }]),
    entry("assistant", "b1", [{ type: "text", text: "Any time." }]),
  ];
}

/** Replies to every prompt with `text`. */
function replying(text: string) {
  return (_message: unknown, query: FakeQuery) => replyMessages(text).forEach((message) => query.emit(message));
}

test("each prompt's uuid is its turn ID", async () => {
  const { sdk, queries } = fakeClaudeSdk({ onUser: replying("Hi") });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Hello");
  const result = await turn.result;
  assert.equal(queries[0]!.inputs[0]!.uuid, result.turnId);
  await engine.close();
});

test("history and readThread group a session into turns by prompt", async () => {
  const { sdk } = fakeClaudeSdk({ sessionMessages: storedSession() });
  const engine = new ClaudeEngine({ sdk });
  const history = await engine.readThread("s1", { cwd: "/tmp" });
  assert.deepEqual(history.turns.map((turn) => turn.id), ["turn-a", "turn-b"]);
  assert.deepEqual(history.turns[0]!.entries, [
    { kind: "message", role: "user", text: "Add a test" },
    { kind: "tool", tool: { kind: "builtin", name: "Write", input: { file_path: "/tmp/a.test.ts" } }, output: "written" },
    { kind: "message", role: "assistant", text: "Added it." },
  ]);
  assert.equal(history.turns[1]!.status, "completed");
  await engine.close();
});

test("listThreads maps sessions, newest first, and searches titles and first prompts", async () => {
  const { sdk } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const threads = await engine.listThreads({ cwd: "/tmp" });
  assert.deepEqual(threads.map((thread) => thread.id), ["s-new", "s-old"]);
  assert.deepEqual(threads[0], {
    id: "s-new", provider: "claude", cwd: "/tmp", title: "Tests", preview: "Add tests",
    createdAt: new Date(1_789_000_000_000), updatedAt: new Date(1_790_000_900_000), gitBranch: "main",
  });
  assert.deepEqual((await engine.listThreads({ search: "build" })).map((thread) => thread.id), ["s-old"]);
  assert.deepEqual(await engine.listThreads({ archived: true }), []);
  await engine.close();
});

test("forkThread forks through the last entry of a turn and resumes the copy", async () => {
  const { sdk, queries, calls } = fakeClaudeSdk({ sessionMessages: storedSession() });
  const engine = new ClaudeEngine({ sdk });
  const fork = await engine.forkThread("s1", { cwd: "/tmp", throughTurnId: "turn-a", title: "Try B" });
  assert.equal(fork.id, "fork-of-s1");
  assert.deepEqual(calls.find((call) => call.method === "forkSession")!.args, ["s1", { dir: "/tmp", upToMessageId: "a2", title: "Try B" }]);
  assert.equal(queries[0]!.options.resume, "fork-of-s1");
  await engine.close();
});

test("rewind restores files at the prompt, then resumes the session from just before it", async () => {
  const { sdk, queries } = fakeClaudeSdk({ sessionMessages: storedSession() });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.resumeThread("s1", { cwd: "/tmp", fileCheckpoints: true });
  assert.equal(queries[0]!.options.enableFileCheckpointing, true);
  const result = await thread.rewind("turn-b", { files: true });
  assert.deepEqual(result, { droppedTurns: 1, files: { paths: ["/tmp/a.ts"], insertions: 2, deletions: 1 } });
  assert.deepEqual(queries[0]!.calls.find((call) => call.method === "rewindFiles")!.args, ["turn-b", undefined]);
  assert.equal(queries[0]!.closed, true);
  assert.equal(queries[1]!.options.resume, "s1");
  assert.equal(queries[1]!.options.resumeSessionAt, "a2");
  assert.equal(queries[1]!.options.resumeDropsTurn, "turn-b");
  await engine.close();
});

test("rewinding several turns leaves the dropped range unchecked; the first turn cannot be rewound", async () => {
  const { sdk, queries } = fakeClaudeSdk({ sessionMessages: storedSession() });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.resumeThread("s1", { cwd: "/tmp" });
  await assert.rejects(thread.rewind("turn-a"), /nothing before the first turn/u);
  await assert.rejects(thread.rewind("turn-b", { files: true }), UnsupportedFeatureError, "files need fileCheckpoints");
  await assert.rejects(thread.rewind("nope"), /No turn nope/u);
  await engine.close();
  assert.equal(queries.length, 1);
});

test("a later prompt drops the rewind point, so a restart resumes normally", async () => {
  const { sdk, queries } = fakeClaudeSdk({ sessionMessages: storedSession(), onUser: replying("ok") });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.resumeThread("s1", { cwd: "/tmp" });
  await thread.rewind("turn-b");
  await thread.run("Again").result;
  // The process exits between turns; the next turn starts a new one.
  queries[1]!.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await thread.run("Once more").result).status, "completed");
  assert.equal(queries.length, 3);
  assert.equal(queries[2]!.options.resume, "s1");
  assert.equal(queries[2]!.options.resumeSessionAt, undefined);
  await engine.close();
});

test("an output schema starts the process with it and the result carries the parsed output", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (_message, query) => {
      const messages = replyMessages('{"tag":"answer"}');
      messages[messages.length - 1] = { ...messages[messages.length - 1], structured_output: { tag: "answer" } };
      messages.forEach((message) => query.emit(message));
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const schema = { type: "object", properties: { tag: { type: "string" } } };
  const thread = await engine.startThread({ cwd: "/tmp" });
  assert.equal(queries[0]!.options.outputFormat, undefined);
  const result = await thread.run("Classify", { outputSchema: schema }).result;
  assert.deepEqual(result.output, { tag: "answer" });
  assert.equal(queries[0]!.closed, true, "a new schema restarts the process");
  assert.deepEqual(queries[1]!.options.outputFormat, { type: "json_schema", schema });
  await thread.run("Classify again", { outputSchema: schema }).result;
  assert.equal(queries.length, 2, "the same schema keeps the process");
  await engine.close();
});

test("switching mode sets the permission mode; switching access restarts with the new one", async () => {
  const { sdk, queries } = fakeClaudeSdk({ onUser: replying("ok") });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", access: "accept-edits" });
  assert.equal(queries[0]!.options.permissionMode, "acceptEdits");
  await thread.run("Plan", { mode: "plan" }).result;
  assert.deepEqual(queries[0]!.calls.filter((call) => call.method === "setPermissionMode").map((call) => call.args[0]), ["plan"]);
  await thread.run("Build", { mode: "default" }).result;
  assert.deepEqual(queries[0]!.calls.filter((call) => call.method === "setPermissionMode").map((call) => call.args[0]), ["plan", "acceptEdits"]);
  await thread.run("Look only", { access: "read-only" }).result;
  assert.equal(queries.length, 2);
  assert.equal(queries[1]!.options.permissionMode, "dontAsk");
  assert.ok(queries[1]!.options.disallowedTools.includes("Bash"));
  await engine.close();
});

test("a thread started in plan mode keeps the bypass flag so it can leave plan mode", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  await engine.startThread({ cwd: "/tmp", access: "full", mode: "plan" });
  assert.equal(queries[0]!.options.permissionMode, "plan");
  assert.equal(queries[0]!.options.allowDangerouslySkipPermissions, true);
  await engine.close();
});

test("files go in as documents: PDFs as base64, text as text, others by path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ae-files-"));
  await writeFile(join(dir, "notes.md"), "# Notes\n");
  await writeFile(join(dir, "data.bin"), Buffer.from([1, 2, 3]));
  const { sdk, queries } = fakeClaudeSdk({ onUser: replying("ok") });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  await thread.run({
    text: "Read these",
    files: [
      { type: "path", path: join(dir, "notes.md") },
      { type: "base64", name: "spec.pdf", mediaType: "application/pdf", data: "JVBERi0=" },
      { type: "path", path: join(dir, "data.bin") },
    ],
  }).result;
  const content = queries[0]!.inputs[0]!.message.content;
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, `Read these\n\nAttached files:\n- ${join(dir, "data.bin")}`);
  assert.deepEqual(content[1], { type: "document", title: "notes.md", source: { type: "text", media_type: "text/plain", data: "# Notes\n" } });
  assert.deepEqual(content[2], { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } });
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

test("thread options: limits, agents, folders, fallbacks, suggestions, title and plugins", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk, configDir: "/alt/claude" });
  await engine.startThread({
    cwd: "/tmp",
    title: "Research",
    limits: { maxTurns: 8, maxBudgetUsd: 2, tokenBudget: 50_000 },
    agents: { reviewer: { description: "Reviews diffs", prompt: "Be thorough.", tools: ["Read"] } },
    additionalDirectories: ["/data"],
    fallbackModels: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    promptSuggestions: true,
    progressSummaries: false,
    claude: { plugins: [{ type: "local", path: "/plugins/x" }], hooks: { PreToolUse: [] } },
  });
  const options = queries[0]!.options;
  assert.equal(options.title, "Research");
  assert.equal(options.maxTurns, 8);
  assert.equal(options.maxBudgetUsd, 2);
  assert.deepEqual(options.taskBudget, { total: 50_000 });
  assert.deepEqual(options.agents, { reviewer: { description: "Reviews diffs", prompt: "Be thorough.", tools: ["Read"] } });
  assert.deepEqual(options.additionalDirectories, ["/data"]);
  assert.equal(options.fallbackModel, "claude-sonnet-5-5,claude-haiku-5-5");
  assert.equal(options.promptSuggestions, true);
  assert.equal(options.agentProgressSummaries, false);
  assert.equal(options.includeHookEvents, true);
  assert.deepEqual(options.plugins, [{ type: "local", path: "/plugins/x" }]);
  assert.deepEqual(options.hooks, { PreToolUse: [] });
  assert.equal(options.env.CLAUDE_CONFIG_DIR, "/alt/claude");
  await engine.close();
});

test("running out of the thread's own turns is a limit error", async () => {
  const { sdk } = fakeClaudeSdk({ onUser: (_message, query) => query.emit({ type: "result", subtype: "error_max_turns", is_error: true, errors: [], modelUsage: {} }) });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", limits: { maxTurns: 1 } });
  const result = await thread.run("Go").result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "limit");
  await engine.close();
});

test("a switch to a listed fallback model is not a silent swap", async () => {
  const { sdk } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "system", subtype: "model_refusal_fallback", original_model: "claude-haiku-5-5", fallback_model: "claude-sonnet-5-5" });
      replyMessages("ok").forEach((message) => query.emit(message));
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", model: "claude-haiku-5-5", fallbackModels: ["claude-sonnet-5-5"] });
  assert.equal((await thread.run("Hi").result).status, "completed");
  await engine.close();
});

test("hooks, notices and prompt suggestions become events", async () => {
  const { sdk } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "lint", hook_event: "PreToolUse" });
      query.emit({ type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "lint", hook_event: "PreToolUse", output: "", stdout: "blocked: lint failed", stderr: "", outcome: "error" });
      query.emit({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t", message: "Bash is denied by a rule", decision_reason: "settings" });
      query.emit({ type: "system", subtype: "informational", content: "Context is getting long", level: "warning" });
      replyMessages("ok").forEach((message) => query.emit(message));
      query.emit({ type: "prompt_suggestion", suggestion: "Run the tests" });
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", promptSuggestions: true });
  const events: AgentEvent[] = [];
  thread.subscribe((event) => events.push(event));
  await thread.run("Go").result;
  await until(() => events.some((event) => event.type === "prompt.suggestion"));
  const interesting = events.filter((event) => ["hook.started", "hook.completed", "notice", "prompt.suggestion"].includes(event.type));
  assert.deepEqual(interesting.map((event) => event.type), ["hook.started", "hook.completed", "notice", "notice", "prompt.suggestion"]);
  assert.deepEqual(interesting[1], { threadId: thread.id, turnId: interesting[1]!.turnId, type: "hook.completed", hookId: "h1", event: "PreToolUse", name: "lint", status: "failed", output: "blocked: lint failed" });
  assert.equal((interesting[2] as Extract<AgentEvent, { type: "notice" }>).kind, "permission-denied");
  assert.equal((interesting[3] as Extract<AgentEvent, { type: "notice" }>).kind, "warning");
  await engine.close();
});

test("tasks() lists what is still running and stopTask stops one", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "system", subtype: "task_started", task_id: "bg1", task_type: "local_bash", description: "npm run dev", tool_use_id: "t1" });
      query.emit({ type: "system", subtype: "task_started", task_id: "bg2", task_type: "local_bash", description: "npm test", tool_use_id: "t2" });
      query.emit({ type: "system", subtype: "task_notification", task_id: "bg2", status: "completed" });
      replyMessages("ok").forEach((message) => query.emit(message));
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  await thread.run("Start the server").result;
  assert.deepEqual(await thread.tasks(), [{ id: "bg1", kind: "shell", description: "npm run dev", status: "running" }]);
  await thread.stopTask("bg1");
  assert.deepEqual(queries[0]!.calls.find((call) => call.method === "stopTask")!.args, ["bg1"]);
  await engine.close();
});

test("MCP controls, context usage, skills and plugins go to the running process", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  assert.deepEqual(await thread.setMcpServers({ notes: { command: "node", args: ["notes.js"] } }), { added: ["notes"], removed: [], errors: {} });
  await thread.reconnectMcp("notes");
  await thread.toggleMcp("notes", false);
  assert.deepEqual(await thread.readMcpResource("notes", "notes://1"), [{ uri: "notes://1", mimeType: "text/plain", text: "resource text" }]);
  assert.deepEqual(await thread.contextUsage(), {
    usedTokens: 1200, maxTokens: 200_000, percent: 0.6,
    categories: [{ name: "Messages", tokens: 1200, kind: "used" }, { name: "Free space", tokens: 198_800, kind: "free" }],
  });
  assert.deepEqual(await thread.reloadSkills(), [{ name: "deploy", kind: "command", description: "Ship it" }]);
  await thread.reloadPlugins();
  const methods = queries[0]!.calls.map((call) => call.method);
  for (const method of ["setMcpServers", "reconnectMcpServer", "toggleMcpServer", "readMcpResource", "getContextUsage", "reloadSkills", "reloadPlugins"]) assert.ok(methods.includes(method), method);
  assert.deepEqual(queries[0]!.calls.find((call) => call.method === "setMcpServers")!.args[0], { notes: { type: "stdio", command: "node", args: ["notes.js"] } });
  await assert.rejects(thread.mcpLogin("notes"), UnsupportedFeatureError);
  await engine.close();
});

test("rename, config and plugins use the SDK; archive and sign-in are refused", async () => {
  const { sdk, calls } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  await engine.renameThread("s1", "New title", { cwd: "/tmp" });
  assert.deepEqual(calls.find((call) => call.method === "renameSession")!.args, ["s1", "New title", { dir: "/tmp" }]);
  const config = await engine.config({ cwd: "/tmp" });
  assert.deepEqual(config, { provider: "claude", values: { model: "opus" }, sources: [{ name: "userSettings", path: "/home/.claude/settings.json", values: { model: "opus" } }] });
  assert.deepEqual(await engine.plugins({ cwd: "/tmp" }), [{ id: "linear", name: "linear", installed: true, enabled: true, marketplace: "official", version: "1.0" }]);
  await assert.rejects(engine.archiveThread("s1", { cwd: "/tmp" }), UnsupportedFeatureError);
  await assert.rejects(engine.login(), UnsupportedFeatureError);
  await engine.close();
});

test("review() runs a review prompt as a turn", async () => {
  const { sdk, queries } = fakeClaudeSdk({ onUser: replying("No issues found.") });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const result = await thread.review({ type: "uncommitted" }).result;
  assert.equal(result.text, "No issues found.");
  assert.match(queries[0]!.inputs[0]!.message.content, /^Review the uncommitted changes/u);
  await engine.close();
});

test("a seed goes before the first prompt only", async () => {
  const { sdk, queries } = fakeClaudeSdk({ onUser: replying("ok") });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({
    cwd: "/tmp",
    seed: { provider: "codex", threadId: "t1", turns: [{ id: "1", status: "completed", entries: [{ kind: "message", role: "user", text: "Plan the trip" }, { kind: "message", role: "assistant", text: "Day one: Rome." }] }] },
  });
  await thread.run("Add day two").result;
  await thread.run("Thanks").result;
  const first: string = queries[0]!.inputs[0]!.message.content;
  assert.match(first, /<earlier-conversation>\nUser: Plan the trip\nAssistant: Day one: Rome\.\n<\/earlier-conversation>/u);
  assert.ok(first.endsWith("Add day two"));
  assert.equal(queries[0]!.inputs[1]!.message.content, "Thanks");
  await engine.close();
});

test("prewarm opens a thread's process ahead and the next matching startThread takes it", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const options = { cwd: "/tmp", model: "claude-haiku-5-5", mcpServers: { notes: { command: "node", args: ["n.js"] } } };
  await engine.prewarm(options);
  assert.equal(queries.length, 1);
  const thread = await engine.startThread({ ...options, mcpServers: { notes: { command: "node", args: ["n.js"] } } });
  assert.equal(queries.length, 1, "the prewarmed process was used");
  assert.equal(thread.id, queries[0]!.options.sessionId);
  await engine.startThread({ cwd: "/tmp", model: "claude-haiku-5-5" });
  assert.equal(queries.length, 2, "different options get a new process");
  await engine.close();
});

test("goals, shell and realtime are refused", async () => {
  const { sdk } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  await assert.rejects(thread.setGoal("x"), UnsupportedFeatureError);
  await assert.rejects(thread.shell("ls"), UnsupportedFeatureError);
  await assert.rejects(thread.realtime(), UnsupportedFeatureError);
  await engine.close();
});

test("leaving plan mode is a plan request carrying the plan, and approving it restores the access mode", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", access: "accept-edits", mode: "plan" });
  const canUseTool = queries[0]!.options.canUseTool;
  const events: AgentEvent[] = [];
  thread.subscribe((event) => events.push(event));
  const decision = canUseTool("ExitPlanMode", { plan: "1. Write the file" }, { signal: new AbortController().signal, toolUseID: "tu-plan" });
  await until(() => events.some((event) => event.type === "request"));
  const request = (events.find((event) => event.type === "request") as Extract<AgentEvent, { type: "request" }>).request;
  assert.equal(request.kind, "approval");
  assert.equal(request.kind === "approval" && request.action, "plan");
  assert.equal(request.kind === "approval" && request.plan, "1. Write the file");
  if (request.kind === "approval") await request.respond({ decision: "allow" });
  assert.equal((await decision).behavior, "allow");
  await until(() => queries[0]!.calls.some((call) => call.method === "setPermissionMode"));
  assert.deepEqual(queries[0]!.calls.find((call) => call.method === "setPermissionMode")!.args, ["acceptEdits"]);
  await engine.close();
});

test("ExitPlanMode's plan is a plan proposal event", async () => {
  const { sdk } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu-plan", name: "ExitPlanMode", input: { plan: "1. Do it" } }] } });
      replyMessages("Waiting for approval.").forEach((message) => query.emit(message));
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", mode: "plan" });
  const events: AgentEvent[] = [];
  for await (const event of thread.run("Plan")) events.push(event);
  assert.deepEqual(events.find((event) => event.type === "plan.proposal.done"), { threadId: thread.id, turnId: events[0]!.turnId, type: "plan.proposal.done", itemId: "tu-plan", text: "1. Do it" });
  await engine.close();
});

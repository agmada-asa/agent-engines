/** @file The Claude engine against a scripted fake SDK: options, turns, steer, interrupt, compact, requests. */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeEngine } from "../src/claude/engine.ts";
import { RuntimeAuthError, RuntimeCompatibilityError, RuntimeModelUnavailableError, SteerRejectedError } from "../src/errors.ts";
import type { AgentEvent } from "../src/types.ts";
import { until } from "./fake-app-server.ts";
import { fakeClaudeSdk, replyMessages } from "./fake-claude-sdk.ts";

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("startThread maps neutral options onto SDK options and checks before any prompt", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk, env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant" } });
  const thread = await engine.startThread({
    cwd: "/tmp/work", model: "claude-haiku-5-5", effort: "low", fastMode: true, access: "full", instructions: "Be brief.",
    env: { EXTRA: "1" }, mcpServers: { notes: { command: "/usr/bin/node", args: ["mcp.js"] }, remote: { type: "http", url: "https://x.test/mcp" }, host: { type: "sdk", name: "host", instance: { inProcess: true } } },
    claude: { settingSources: ["user"], disallowedTools: ["WebFetch"], extra: { maxTurns: 5 } },
  });
  const options = queries[0].options;
  assert.equal(options.sessionId, thread.id);
  assert.equal(options.resume, undefined);
  assert.equal(options.cwd, "/tmp/work");
  assert.equal(options.model, "claude-haiku-5-5");
  assert.equal(options.effort, "low");
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: "Be brief." });
  assert.deepEqual(options.settings, { fastMode: true });
  assert.deepEqual(options.settingSources, ["user"]);
  assert.deepEqual(options.disallowedTools, ["WebFetch"]);
  assert.equal(options.maxTurns, 5);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.forwardSubagentText, true);
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env.EXTRA, "1");
  assert.deepEqual(options.mcpServers, {
    notes: { type: "stdio", command: "/usr/bin/node", args: ["mcp.js"] },
    remote: { type: "http", url: "https://x.test/mcp" },
    host: { type: "sdk", name: "host", instance: { inProcess: true } },
  });
  assert.equal(queries[0].inputs.length, 0);
  await engine.close();
  assert.equal(queries[0].closed, true);
});

test("a turn streams events and ends on result", async () => {
  const { sdk } = fakeClaudeSdk({ onUser: (_message, query) => replyMessages("Hello there").forEach((m) => query.emit(m)) });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", model: "claude-haiku-5-5" });
  const turn = thread.run("Say hi");
  const events = await collect(turn);
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "text.delta", "text.done", "turn.completed"]);
  const result = await turn.result;
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hello there");
  assert.equal(result.usage?.totalTokens, 18);
  assert.equal(result.turnId, await turn.id);
  await engine.close();
});

test("per-turn model, effort and fast mode go through the SDK controls", async () => {
  const { sdk, queries } = fakeClaudeSdk({ onUser: (_message, query) => replyMessages("ok").forEach((m) => query.emit(m)) });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  await thread.run("x", { model: "claude-haiku-5-5", effort: "high", fastMode: false }).result;
  assert.deepEqual(queries[0].calls.filter((call) => call.method !== "initializationResult"), [
    { method: "setModel", args: ["claude-haiku-5-5"] },
    { method: "applyFlagSettings", args: [{ effortLevel: "high", fastMode: false }] },
  ]);
  await engine.close();
});

test("steer sends a second message into the running turn, and a queued result does not end it", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (message, query) => {
      if (query.inputs.length === 2) {
        query.emit({ type: "result", subtype: "success", is_error: false, result: "first", queued_turn_count: 1, modelUsage: {} });
        replyMessages("Both done", "msg_2").forEach((m) => query.emit(m));
      }
      void message;
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Start");
  await until(() => queries[0].inputs.length === 1);
  await turn.steer("And this");
  const result = await turn.result;
  assert.equal(result.text, "Both done");
  assert.equal(queries[0].inputs[1].priority, "next");
  assert.equal(queries[0].inputs[1].message.content, "And this");
  await assert.rejects(turn.steer("late"), SteerRejectedError);
  await engine.close();
});

test("interrupt ends the turn as interrupted", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m" } } });
    },
    onInterrupt: (query) => query.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["aborted"], modelUsage: {} }),
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Long task");
  await until(() => queries[0].inputs.length === 1);
  await turn.interrupt();
  const result = await turn.result;
  assert.equal(result.status, "interrupted");
  await engine.close();
});

test("compact sends /compact and reports the compaction", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 5000, post_tokens: 800 } });
      query.emit({ type: "result", subtype: "success", is_error: false, result: "", modelUsage: {} });
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const events = await collect(thread.compact());
  assert.equal(queries[0].inputs[0].message.content, "/compact");
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "compacted", "turn.completed"]);
  await engine.close();
});

test("permission prompts and AskUserQuestion surface as requests", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", access: "ask" });
  assert.equal(queries[0].options.permissionMode, "default");
  thread.subscribe((event) => {
    if (event.type !== "request") return;
    if (event.request.kind === "approval") void event.request.respond({ decision: event.request.tool === "Bash" ? "allow" : "deny", message: "No." });
    if (event.request.kind === "question") void event.request.respond({ "Which colour?": ["Blue"] });
  });
  const canUseTool = queries[0].options.canUseTool;
  const signal = new AbortController().signal;
  assert.deepEqual(await canUseTool("Bash", { command: "ls" }, { signal, toolUseID: "t1" }), { behavior: "allow", updatedInput: { command: "ls" } });
  assert.deepEqual(await canUseTool("Write", { file_path: "/x" }, { signal, toolUseID: "t2" }), { behavior: "deny", message: "No." });
  const questionInput = { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiSelect: false }] };
  assert.deepEqual(await canUseTool("AskUserQuestion", questionInput, { signal, toolUseID: "t3" }), {
    behavior: "allow", updatedInput: { ...questionInput, answers: { "Which colour?": "Blue" } },
  });
  const aborted = new AbortController();
  const pending = canUseTool("Edit", {}, { signal: aborted.signal, toolUseID: "t4" });
  aborted.abort();
  assert.equal((await pending).behavior, "deny");
  await engine.close();
});

test("subscription, version and model checks fail the thread before any prompt", async () => {
  const onKey = fakeClaudeSdk({ account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } });
  await assert.rejects(new ClaudeEngine({ sdk: onKey.sdk }).startThread({ cwd: "/tmp" }), RuntimeAuthError);
  assert.equal(onKey.queries[0].closed, true);
  const relaxed = await new ClaudeEngine({ sdk: onKey.sdk, requireSubscription: false }).startThread({ cwd: "/tmp" });
  await relaxed.close();
  const old = fakeClaudeSdk({ version: "2.0.1" });
  await assert.rejects(new ClaudeEngine({ sdk: old.sdk }).startThread({ cwd: "/tmp" }), RuntimeCompatibilityError);
  const models = fakeClaudeSdk();
  await assert.rejects(new ClaudeEngine({ sdk: models.sdk }).startThread({ cwd: "/tmp", model: "claude-nope" }), RuntimeModelUnavailableError);
  await assert.rejects(new ClaudeEngine({ sdk: models.sdk }).startThread({ cwd: "/tmp", model: "claude-haiku-5-5", effort: "max" }), RuntimeModelUnavailableError);
});

test("availability and models come from the no-prompt probe", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const availability = await engine.availability();
  assert.deepEqual(availability, {
    provider: "claude", ready: true, reason: "ready", message: "Claude is signed in with a Claude subscription.", version: "2.1.308",
    account: { kind: "subscription", plan: "max", email: "someone@example.com" },
  });
  assert.deepEqual(await engine.models(), [{ id: "claude-haiku-5-5", label: "Haiku 5.5", description: "Fast", efforts: ["low", "medium", "high"], fastMode: false, isDefault: false }]);
  assert.equal(queries.every((query) => query.closed && query.inputs.length === 0), true);
  const signedOut = fakeClaudeSdk({ account: {} });
  assert.equal((await new ClaudeEngine({ sdk: signedOut.sdk }).availability()).reason, "signed-out");
});

test("usage() reads the plan's windows from a probe that starts no MCP server", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    usage: {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 46, resets_at: "2026-10-22T19:40:00.445Z" },
        seven_day: { utilization: 26, resets_at: "2026-10-28T06:00:00.445Z" },
        seven_day_opus: null,
        seven_day_oauth_apps: { utilization: 3, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-28T06:00:00.000Z" }],
      },
    },
  });
  const report = await new ClaudeEngine({ sdk }).usage();
  assert.equal(report.available, true);
  assert.equal(report.plan, "max");
  assert.deepEqual(report.windows, [
    { kind: "session", name: "five_hour", usedPercent: 46, resetsAt: new Date("2026-10-22T19:40:00.445Z") },
    { kind: "weekly", name: "seven_day", usedPercent: 26, resetsAt: new Date("2026-10-28T06:00:00.445Z") },
    { kind: "weekly", name: "seven_day_fable", model: "Fable", usedPercent: 0, resetsAt: new Date("2026-10-28T06:00:00.000Z") },
  ]);
  assert.deepEqual(queries[0].calls.at(-1), { method: "usage", args: [{ skipBehaviors: true }] });
  assert.equal(queries[0].options.strictMcpConfig, true);
  assert.deepEqual(queries[0].options.mcpServers, {});
  assert.equal(queries[0].closed, true);
  const none = fakeClaudeSdk();
  assert.deepEqual((await new ClaudeEngine({ sdk: none.sdk }).usage()).windows, []);
});

test("commands() lists slash commands and skills with the folder's settings loaded", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    commands: [
      { name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>", builtin: true },
      { name: "figma:figma-use", description: "Use Figma", argumentHint: "" },
      { name: "compact", description: "A duplicate", argumentHint: "" },
    ],
  });
  assert.deepEqual(await new ClaudeEngine({ sdk }).commands({ cwd: "/tmp/work" }), [
    { name: "compact", kind: "command", description: "Clear history but keep a summary", argumentHint: "<instructions>", builtin: true },
    { name: "figma:figma-use", kind: "command", description: "Use Figma" },
  ]);
  assert.equal(queries[0].options.cwd, "/tmp/work");
  assert.equal(queries[0].options.settingSources, undefined);
  assert.equal(queries[0].options.strictMcpConfig, true);
  assert.equal(queries[0].inputs.length, 0);
});

test("a usage limit fails the turn with its reset time", async () => {
  const { sdk } = fakeClaudeSdk({
    onUser: (_message, query) => {
      query.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1800000000, rateLimitType: "five_hour" } });
      query.emit({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { id: "m", content: [{ type: "text", text: "You've hit your limit" }] } });
      query.emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", modelUsage: {} });
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const result = await thread.run("hi").result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "usage-limit");
  assert.equal(result.error?.resetsAt?.getTime(), 1800000000 * 1000);
  await engine.close();
});

test("a process exit fails the turn; the next turn resumes the session in a new process", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (_message, query) => {
      if (queries.length === 1) query.end();
      else replyMessages("back").forEach((m) => query.emit(m));
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const failed = await thread.run("hi").result;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.kind, "connection");
  const next = await thread.run("again").result;
  assert.equal(next.text, "back");
  assert.equal(queries[1].options.resume, thread.id);
  await engine.close();
});

test("a turn the agent starts itself gets a handle and reaches subscribers", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const seen: string[] = [];
  thread.subscribe((event) => seen.push(event.type));
  replyMessages("A background agent finished.").forEach((m) => queries[0].emit(m));
  await until(() => seen.includes("turn.completed"));
  assert.deepEqual(seen, ["turn.started", "text.delta", "text.done", "turn.completed"]);
  await engine.close();
});

test("subagent transcripts and resumeThread", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.resumeThread("saved-session", { cwd: "/tmp" });
  assert.equal(queries[0].options.resume, "saved-session");
  const transcript = await thread.subagentTranscript("agent-1");
  assert.equal(transcript.length, 3);
  assert.deepEqual(transcript[1], { kind: "tool", tool: { kind: "builtin", name: "Glob", input: { pattern: "*.md" } }, output: "README.md" });
  // Read back from the transcript, which records no status.
  assert.deepEqual(await thread.lastTurn(), { status: "unknown", text: "Hello" });
  // A session that never got a prompt is opened fresh under its ID.
  await engine.resumeThread("never-prompted", { cwd: "/tmp" });
  assert.equal(queries[1].options.sessionId, "never-prompted");
  assert.equal(queries[1].options.resume, undefined);
  await engine.close();
});

test("lastTurn reports a turn this thread ran", async () => {
  const { sdk } = fakeClaudeSdk({ onUser: (_message, query) => replyMessages("Done").forEach((m) => query.emit(m)) });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Hi");
  assert.equal((await thread.lastTurn())?.status, "running");
  await turn.result;
  assert.deepEqual(await thread.lastTurn(), { turnId: await turn.id, status: "completed", text: "Done" });
  await engine.close();
});

test("deleteThread removes the session and the files kept beside it", async () => {
  const home = await mkdtemp(join(tmpdir(), "ae-claude-home-"));
  const id = "0f9d8a6e-1111-4222-8333-444455556666";
  await mkdir(join(home, "projects", "-tmp-work", id, "subagents"), { recursive: true });
  await writeFile(join(home, "projects", "-tmp-work", `${id}.jsonl`), "{}\n");
  await writeFile(join(home, "projects", "-tmp-work", "other.jsonl"), "{}\n");
  await mkdir(join(home, "file-history", id), { recursive: true });
  await mkdir(join(home, "todos"), { recursive: true });
  await writeFile(join(home, "todos", `${id}-agent-${id}.json`), "[]");
  const fake = fakeClaudeSdk();
  const { deleted } = fake;
  // Like the real one, deleteSession removes the transcript itself.
  const sdk = {
    ...fake.sdk,
    deleteSession: async (session: string, options?: { dir?: string }) => {
      await fake.sdk.deleteSession(session, options);
      for (const project of await readdir(join(home, "projects"))) await rm(join(home, "projects", project, `${session}.jsonl`), { force: true });
    },
  };
  const engine = new ClaudeEngine({ sdk, configDir: home });
  await engine.deleteThread(id, { cwd: "/tmp/work" });
  assert.deepEqual(deleted, [{ id, dir: "/tmp/work" }]);
  assert.deepEqual(await readdir(join(home, "projects", "-tmp-work")), ["other.jsonl"]);
  assert.deepEqual(await readdir(join(home, "file-history")), []);
  assert.deepEqual(await readdir(join(home, "todos")), []);
  // A project folder left with only an empty memory folder is removed too.
  const solo = "1f9d8a6e-1111-4222-8333-444455556666";
  await mkdir(join(home, "projects", "-tmp-solo", "memory"), { recursive: true });
  await writeFile(join(home, "projects", "-tmp-solo", `${solo}.jsonl`), "{}\n");
  await engine.deleteThread(solo, { cwd: "/tmp/solo" });
  assert.deepEqual((await readdir(join(home, "projects"))).sort(), ["-tmp-work"]);
  await assert.rejects(engine.deleteThread("../etc", { cwd: "/tmp" }), /not a Claude session ID/);
});

test("read-only access refuses writes", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  await engine.startThread({ cwd: "/tmp", access: "read-only", claude: { disallowedTools: ["WebFetch"] } });
  assert.equal(queries[0].options.permissionMode, "dontAsk");
  assert.deepEqual(queries[0].options.disallowedTools, ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch"]);
  await engine.close();
});

test("a process that throws mid-turn fails it as a lost connection", async () => {
  const { sdk } = fakeClaudeSdk({ onUser: (_message, query) => query.fail(new Error("Claude Code process exited with code 1")) });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const result = await thread.run("hi").result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "connection");
  assert.match(result.error?.message ?? "", /exited with code 1/);
  await engine.close();
});

test("alwaysLoad reaches stdio and http servers", async () => {
  const { sdk, queries } = fakeClaudeSdk();
  const engine = new ClaudeEngine({ sdk });
  await engine.startThread({
    cwd: "/tmp",
    mcpServers: { geo: { command: "/usr/bin/node", args: ["geo.js"], alwaysLoad: true }, remote: { type: "http", url: "https://x.test/mcp", alwaysLoad: false } },
  });
  assert.deepEqual(queries[0].options.mcpServers, {
    geo: { type: "stdio", command: "/usr/bin/node", args: ["geo.js"], alwaysLoad: true },
    remote: { type: "http", url: "https://x.test/mcp", alwaysLoad: false },
  });
  await engine.close();
});

test("interruptTurn stops the active turn by ID and ignores any other", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onInterrupt: (query) => query.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [], modelUsage: {} }),
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Wait");
  await thread.interruptTurn("not-this-turn");
  assert.equal(queries[0].calls.some((call) => call.method === "interrupt"), false);
  await thread.interruptTurn(await turn.id);
  assert.equal((await turn.result).status, "interrupted");
  await engine.close();
});

test("tool progress and plans stream in the turn; a background task ending later reaches subscribers", async () => {
  const { sdk, queries } = fakeClaudeSdk({
    onUser: (_message, query) => {
      const [init, start, blockStart, delta, assistant, result] = replyMessages("Started the build");
      for (const message of [init, start, blockStart, delta]) query.emit(message);
      query.emit({ type: "system", subtype: "status", status: "requesting" });
      query.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_tools", role: "assistant", content: [
        { type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [{ content: "Build", status: "in_progress", activeForm: "Building" }] } },
        { type: "tool_use", id: "bash", name: "Bash", input: { command: "npm run build", run_in_background: true } },
      ] } });
      query.emit({ type: "tool_progress", tool_use_id: "bash", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 2 });
      query.emit({ type: "system", subtype: "task_started", task_id: "bg-1", tool_use_id: "bash", description: "npm run build", task_type: "local_bash", is_backgrounded: true });
      query.emit(assistant);
      query.emit(result);
    },
  });
  const engine = new ClaudeEngine({ sdk });
  const thread = await engine.startThread({ cwd: "/tmp", model: "claude-haiku-5-5" });
  const seen: AgentEvent[] = [];
  thread.subscribe((event) => seen.push(event));
  const turn = thread.run("Build it in the background");
  const events = await collect(turn);
  assert.deepEqual(events.map((event) => event.type), [
    "turn.started", "text.delta", "status", "tool.started", "plan.updated", "tool.started", "tool.progress", "task.started", "text.done", "turn.completed",
  ]);
  assert.equal((await turn.result).text, "Started the build");

  // The shell finishes after the turn: no turn is running, so only subscribers hear about it.
  queries[0].emit({ type: "system", subtype: "task_notification", task_id: "bg-1", tool_use_id: "bash", status: "completed", output_file: "/tmp/bg-1.log", summary: "Build passed" });
  await until(() => seen.at(-1)?.type === "task.ended");
  assert.deepEqual(seen.at(-1), {
    threadId: thread.id, turnId: "", type: "task.ended", taskId: "bg-1", status: "completed", summary: "Build passed", outputFile: "/tmp/bg-1.log",
  });
  assert.equal(thread.activeTurn, undefined);
  await engine.close();
});

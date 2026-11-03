/** @file The ACP engine end to end against a fake agent: sessions, prompts, streaming, permissions, history, and the normalizer on its own. */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AcpEngine, type AcpEngineOptions } from "../src/acp/engine.ts";
import { AcpNormalizer } from "../src/acp/normalize.ts";
import { AgentEngineError, SteerRejectedError, UnsupportedFeatureError } from "../src/errors.ts";
import type { AgentEvent, AgentRequest, ApprovalRequest, PortableTranscript, QuestionRequest, Thread, Turn } from "../src/types.ts";
import { until } from "./fake-app-server.ts";
import { type AcpHandler, FakeAcpAgent, FakeRpcError, NO_REPLY, fakeAcpSpawner } from "./fake-acp-agent.ts";

const CWD = tmpdir();

const PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject once", kind: "reject_once" },
];

/** An engine on a fake agent. `agent()` is the child, once the engine has started it. */
function engineWith(handlers: Record<string, AcpHandler> = {}, options: Partial<AcpEngineOptions> = {}) {
  const { spawn, children } = fakeAcpSpawner(handlers);
  const engine = new AcpEngine({ command: "fake-agent", args: ["acp"], cwd: CWD, spawnProcess: spawn, ...options });
  return { engine, agent: (): FakeAcpAgent => children[0]! };
}

/** Every event a turn emits, in order. */
async function drain(turn: Turn): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of turn) events.push(event);
  return events;
}

/** The events of one type, typed. */
function ofType<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

/** A prompt that asks for one permission per tool call, records each answer, then ends the turn. */
function permissionPrompt(answers: unknown[], ...toolCalls: Array<Record<string, unknown>>): AcpHandler {
  return async (params, server) => {
    for (const toolCall of toolCalls) {
      answers.push(await server.ask("session/request_permission", { sessionId: params.sessionId, toolCall, options: PERMISSION_OPTIONS }));
    }
    return { stopReason: "end_turn" };
  };
}

test("availability() is ready and reports the agent's version", async () => {
  const { engine } = engineWith();
  const availability = await engine.availability();
  assert.equal(availability.ready, true);
  assert.equal(availability.reason, "ready");
  assert.equal(availability.version, "1.2.3");
  await engine.close();
});

test("availability() reports a missing executable when the spawn fails with ENOENT", async () => {
  const engine = new AcpEngine({
    command: "fake-agent",
    spawnProcess: () => {
      const child = new FakeAcpAgent();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn fake-agent ENOENT"), { code: "ENOENT" })));
      return child;
    },
  });
  const availability = await engine.availability();
  assert.equal(availability.ready, false);
  assert.equal(availability.reason, "missing-executable");
  await engine.close();
});

test("capabilities() reflects what the agent's initialize answer offers", async () => {
  const { engine } = engineWith();
  const caps = await engine.capabilities();
  assert.equal(caps.fork, true);
  assert.equal(caps.history, true);
  assert.equal(caps.images, true);
  assert.equal(caps.files, "content");
  assert.equal(caps.steer, false);
  assert.deepEqual(caps.modes, ["default"]);
  await engine.close();
});

test("capabilities() turns off what the agent does not offer", async () => {
  const { engine } = engineWith({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } }, agentInfo: { name: "bare", version: "0.1.0" } }),
  });
  const caps = await engine.capabilities();
  assert.equal(caps.fork, false);
  assert.equal(caps.history, false);
  assert.equal(caps.images, false);
  assert.equal(caps.files, "paths");
  await engine.close();
});

test("capabilities().history needs both loading and listing sessions", async () => {
  const { engine } = engineWith({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "load-only", version: "0.1.0" } }),
  });
  // listThreads would fail without session/list, so history is not claimed.
  assert.equal((await engine.capabilities()).history, false);
  await engine.close();
});

test("capabilities().modes gains plan once a session offers a plan mode", async () => {
  const { engine } = engineWith();
  await engine.startThread({ cwd: CWD });
  assert.deepEqual((await engine.capabilities()).modes, ["default", "plan"]);
  await engine.close();
});

test("models() lists the agent's model options", async () => {
  const { engine } = engineWith();
  assert.deepEqual(await engine.models(), [
    { id: "model-a", label: "Model A", description: "Fast", efforts: ["low", "high"], fastMode: false, isDefault: true },
    { id: "model-b", label: "Model B", efforts: ["low", "high"], fastMode: false, isDefault: false },
  ]);
  await engine.close();
});

test("startThread sends session/new with the cwd and MCP servers in ACP shape", async () => {
  const { engine, agent } = engineWith();
  await engine.startThread({
    cwd: CWD,
    mcpServers: {
      docs: { command: "docs-mcp", args: ["--stdio"], env: { TOKEN: "t" } },
      remote: { type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer x" } },
    },
  });
  assert.deepEqual(agent().requests("session/new"), [{
    cwd: CWD,
    mcpServers: [
      { name: "docs", command: "docs-mcp", args: ["--stdio"], env: [{ name: "TOKEN", value: "t" }] },
      { type: "http", name: "remote", url: "https://mcp.example.test/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ],
  }]);
  await engine.close();
});

test("startThread rejects an in-process SDK MCP server before opening a session", async () => {
  const { engine, agent } = engineWith();
  await assert.rejects(
    engine.startThread({ cwd: CWD, mcpServers: { inproc: { type: "sdk", name: "inproc", instance: {} } } }),
    (error: unknown) => error instanceof AgentEngineError && /in-process/u.test(error.message),
  );
  assert.deepEqual(agent().requests("session/new"), []);
  await engine.close();
});

test("startThread with a model and effort sends session/set_config_option for each", async () => {
  const { engine, agent } = engineWith();
  await engine.startThread({ cwd: CWD, model: "model-b", effort: "high" });
  assert.deepEqual(agent().requests("session/set_config_option"), [
    { sessionId: "sess-1", configId: "model", value: "model-b" },
    { sessionId: "sess-1", configId: "thought_level", value: "high" },
  ]);
  await engine.close();
});

test("startThread fails on a model the agent does not offer, and sets nothing", async () => {
  const { engine, agent } = engineWith();
  await assert.rejects(engine.startThread({ cwd: CWD, model: "model-z" }), /does not offer model model-z/u);
  assert.deepEqual(agent().requests("session/set_config_option"), []);
  await engine.close();
});

test("run() streams message chunks as text deltas, then text.done and the reply", async () => {
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Say hello");
  const events = await drain(turn);
  const result = await turn.result;
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "text.delta", "text.delta", "text.done", "turn.completed"]);
  assert.deepEqual(ofType(events, "text.delta").map((event) => event.delta), ["Hel", "lo"]);
  assert.deepEqual(ofType(events, "text.done").map((event) => event.text), ["Hello"]);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hello");
  await engine.close();
});

test("run() ends with the last agent message as the reply", async () => {
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking." } });
      server.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "List files", kind: "search", status: "completed" });
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Look around");
  await drain(turn);
  assert.equal((await turn.result).text, "Done.");
  await engine.close();
});

test("run() reports a tool call and its text output", async () => {
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read notes.txt", kind: "read", status: "in_progress", rawInput: { path: "notes.txt" } });
      server.update(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hello from the file" } }],
      });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Read it");
  const events = await drain(turn);
  const started = ofType(events, "tool.started");
  const completed = ofType(events, "tool.completed");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]!.tool, { kind: "builtin", name: "Read notes.txt", input: { path: "notes.txt" } });
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.itemId, "call-1");
  assert.equal(completed[0]!.output, "hello from the file");
  assert.equal(completed[0]!.isError, false);
  await engine.close();
});

test("run() reports a file edit carried by a tool call as a unified diff", async () => {
  const path = join(CWD, "notes.txt");
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit notes.txt", kind: "edit", status: "in_progress" });
      server.update(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        content: [{ type: "diff", path, oldText: "one\ntwo\n", newText: "one\n2\n" }],
      });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const events = await drain(thread.run("Fix the number"));
  const changed = ofType(events, "file.changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.changes.length, 1);
  assert.equal(changed[0]!.changes[0]!.path, path);
  assert.equal(changed[0]!.changes[0]!.kind, "update");
  assert.match(changed[0]!.changes[0]!.diff ?? "", /^-two$/mu);
  assert.match(changed[0]!.changes[0]!.diff ?? "", /^\+2$/mu);
  await engine.close();
});

test("run() reports a plan as plan.updated with mapped step statuses", async () => {
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the code", priority: "high", status: "completed" },
          { content: "Write the fix", priority: "medium", status: "in_progress" },
          { content: "Run the tests", priority: "low", status: "pending" },
        ],
      });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const events = await drain(thread.run("Fix it"));
  assert.deepEqual(ofType(events, "plan.updated").map((event) => event.steps), [[
    { step: "Read the code", status: "completed" },
    { step: "Write the fix", status: "in-progress" },
    { step: "Run the tests", status: "pending" },
  ]]);
  await engine.close();
});

test("run() takes context usage from usage updates", async () => {
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "usage_update", used: 2000, size: 8000 });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  await thread.run("Go").result;
  assert.deepEqual(await thread.contextUsage(), { usedTokens: 2000, maxTokens: 8000, percent: 25 });
  await engine.close();
});

test("run() fails with kind limit when the agent stops at max_tokens", async () => {
  const { engine } = engineWith({ "session/prompt": () => ({ stopReason: "max_tokens" }) });
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Write a novel");
  const events = await drain(turn);
  const result = await turn.result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "limit");
  assert.equal(ofType(events, "turn.failed")[0]?.error.kind, "limit");
  await engine.close();
});

test("steer() rejects with SteerRejectedError", async () => {
  const { engine } = engineWith();
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Start");
  await assert.rejects(turn.steer("Also this"), SteerRejectedError);
  await turn.result;
  await engine.close();
});

test("compact() throws UnsupportedFeatureError", async () => {
  const { engine } = engineWith();
  const thread = await engine.startThread({ cwd: CWD });
  assert.throws(() => thread.compact(), UnsupportedFeatureError);
  await engine.close();
});

test("run() with an outputSchema throws UnsupportedFeatureError", async () => {
  const { engine } = engineWith();
  const thread = await engine.startThread({ cwd: CWD });
  assert.throws(() => thread.run("Reply as JSON", { outputSchema: { type: "object" } }), UnsupportedFeatureError);
  await engine.close();
});

test("interrupt() sends session/cancel, and the agent's cancelled answer ends the turn interrupted", async () => {
  let release: (value: unknown) => void = () => undefined;
  const { engine, agent } = engineWith({
    "session/prompt": () => new Promise((resolve) => (release = resolve)),
  });
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Take your time");
  await until(() => agent().requests("session/prompt").length === 1);
  await turn.interrupt();
  await until(() => agent().notifications("session/cancel").length === 1);
  assert.deepEqual(agent().notifications("session/cancel"), [{ sessionId: "sess-1" }]);
  release({ stopReason: "cancelled" });
  const result = await turn.result;
  assert.equal(result.status, "interrupted");
  await engine.close();
});

test("interrupt() closes a running tool call", async () => {
  let release: (value: unknown) => void = () => undefined;
  const { engine, agent } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "run-1", title: "Run the build", kind: "execute", status: "in_progress", rawInput: { command: "make" } });
      return new Promise((resolve) => (release = resolve));
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const seen: AgentEvent[] = [];
  thread.subscribe((event) => seen.push(event));
  const turn = thread.run("Build it");
  await until(() => seen.some((event) => event.type === "tool.started"));
  await turn.interrupt();
  await until(() => agent().notifications("session/cancel").length === 1);
  release({ stopReason: "cancelled" });
  await turn.result;
  assert.ok(seen.some((event) => event.type === "tool.completed" && event.itemId === "run-1"), "no tool.completed for the unfinished tool call");
  await engine.close();
});

test("ask access surfaces a command approval and answers with the chosen option", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({
    "session/prompt": permissionPrompt(answers, { toolCallId: "perm-1", title: "Run the tests", kind: "execute", rawInput: { command: "npm test" } }),
  });
  const thread = await engine.startThread({ cwd: CWD, access: "ask" });
  const turn = thread.run("Test it");
  let approval: ApprovalRequest | undefined;
  for await (const event of turn) {
    if (event.type !== "request") continue;
    approval = event.request as ApprovalRequest;
    await approval.respond({ decision: "allow" });
  }
  assert.equal((await turn.result).status, "completed");
  assert.equal(approval?.kind, "approval");
  assert.equal(approval?.action, "command");
  assert.equal(approval?.command, "npm test");
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "allow" } }]);
  await engine.close();
});

test("full access answers a permission with allow_once and surfaces no request", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({
    "session/prompt": permissionPrompt(answers, { toolCallId: "perm-1", title: "Run the tests", kind: "execute", rawInput: { command: "npm test" } }),
  });
  const thread = await engine.startThread({ cwd: CWD, access: "full" });
  const events = await drain(thread.run("Test it"));
  assert.deepEqual(ofType(events, "request"), []);
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "allow" } }]);
  await engine.close();
});

test("read-only access answers a permission with reject_once and surfaces no request", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({
    "session/prompt": permissionPrompt(answers, { toolCallId: "perm-1", title: "Write a file", kind: "edit" }),
  });
  const thread = await engine.startThread({ cwd: CWD, access: "read-only" });
  const events = await drain(thread.run("Change it"));
  assert.deepEqual(ofType(events, "request"), []);
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "reject" } }]);
  await engine.close();
});

test("accept-edits allows an edit on its own but still surfaces a command", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({
    "session/prompt": permissionPrompt(
      answers,
      { toolCallId: "edit-1", title: "Edit notes.txt", kind: "edit" },
      { toolCallId: "run-1", title: "Run ls", kind: "execute", rawInput: { command: "ls" } },
    ),
  });
  const thread = await engine.startThread({ cwd: CWD, access: "accept-edits" });
  const turn = thread.run("Tidy up");
  const surfaced: ApprovalRequest[] = [];
  for await (const event of turn) {
    if (event.type !== "request") continue;
    const request = event.request as ApprovalRequest;
    surfaced.push(request);
    await request.respond({ decision: "deny" });
  }
  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0]?.command, "ls");
  assert.deepEqual(answers, [
    { outcome: { outcome: "selected", optionId: "allow" } },
    { outcome: { outcome: "selected", optionId: "reject" } },
  ]);
  await engine.close();
});

const QUESTION_CALL = { toolCallId: "interaction_1", status: "pending", title: "Which colour?", rawInput: {} };
const QUESTION_OPTIONS = [
  { optionId: "1", name: "Red", kind: "allow_once" },
  { optionId: "2", name: "Green", kind: "allow_once" },
  { optionId: "3", name: "Blue", kind: "allow_once" },
];

/** A prompt that asks as Antigravity does: announces a tool call, asks permission on it, then finishes it. */
function questionPrompt(answers: unknown[], options: unknown[] = QUESTION_OPTIONS, toolCall: Record<string, unknown> = QUESTION_CALL, announced: Record<string, unknown> = toolCall): AcpHandler {
  return async (params, server) => {
    server.update(params.sessionId, { sessionUpdate: "tool_call", ...announced });
    answers.push(await server.ask("session/request_permission", { sessionId: params.sessionId, toolCall, options }));
    server.update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "completed" });
    return { stopReason: "end_turn" };
  };
}

/** Runs one turn, answers each question with `answer`, and returns the questions that surfaced. */
async function askAndAnswer(thread: Thread, answer: (question: QuestionRequest) => Record<string, string[]>): Promise<QuestionRequest[]> {
  const questions: QuestionRequest[] = [];
  for await (const event of thread.run("Ask me")) {
    if (event.type !== "request") continue;
    assert.equal(event.request.kind, "question");
    const question = event.request as QuestionRequest;
    questions.push(question);
    await question.respond(answer(question));
  }
  return questions;
}

test("an agent's question surfaces with every option, and each option can be chosen", async () => {
  for (const [label, optionId] of [["Red", "1"], ["Green", "2"], ["Blue", "3"]] as const) {
    const answers: unknown[] = [];
    const { engine } = engineWith({ "session/prompt": questionPrompt(answers) });
    const thread = await engine.startThread({ cwd: CWD, access: "ask" });
    const [question] = await askAndAnswer(thread, (asked) => ({ [asked.questions[0]!.id]: [label] }));
    assert.equal(question?.id, "interaction_1");
    assert.deepEqual(question?.questions, [{
      id: "interaction_1",
      header: "",
      question: "Which colour?",
      options: [{ label: "Red", description: "" }, { label: "Green", description: "" }, { label: "Blue", description: "" }],
      multiSelect: false,
      allowOther: false,
      secret: false,
    }]);
    assert.deepEqual((question?.raw as { options: unknown }).options, QUESTION_OPTIONS);
    assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId } }]);
    await engine.close();
  }
});

test("no access level answers a question on its own", async () => {
  for (const access of ["full", "accept-edits", "ask", "read-only"] as const) {
    const answers: unknown[] = [];
    const { engine } = engineWith({ "session/prompt": questionPrompt(answers) });
    const thread = await engine.startThread({ cwd: CWD, access });
    const questions = await askAndAnswer(thread, (asked) => {
      assert.deepEqual(answers, [], `${access} answered before the caller did`);
      return { [asked.questions[0]!.id]: ["Blue"] };
    });
    assert.equal(questions.length, 1, access);
    assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "3" } }], access);
    await engine.close();
  }
});

test("a question with only an id in its request still reads what was announced", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({ "session/prompt": questionPrompt(answers, QUESTION_OPTIONS, { toolCallId: "interaction_1" }, QUESTION_CALL) });
  const thread = await engine.startThread({ cwd: CWD, access: "full" });
  const [question] = await askAndAnswer(thread, (asked) => ({ [asked.questions[0]!.id]: ["Green"] }));
  assert.equal(question?.questions[0]?.question, "Which colour?");
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "2" } }]);
  await engine.close();
});

test("an empty answer declines a question", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({ "session/prompt": questionPrompt(answers) });
  const thread = await engine.startThread({ cwd: CWD, access: "ask" });
  await askAndAnswer(thread, () => ({}));
  assert.deepEqual(answers, [{ outcome: { outcome: "cancelled" } }]);
  await engine.close();
});

test("an answer that is not one option is refused and the question stays open", async () => {
  const answers: unknown[] = [];
  const { engine } = engineWith({ "session/prompt": questionPrompt(answers) });
  const thread = await engine.startThread({ cwd: CWD, access: "ask" });
  for await (const event of thread.run("Ask me")) {
    if (event.type !== "request") continue;
    const question = event.request as QuestionRequest;
    const id = question.questions[0]!.id;
    for (const wrong of [{ [id]: ["Purple"] }, { [id]: ["Red", "Blue"] }, { [id]: [] }, { "another-question": ["Red"] }]) {
      await assert.rejects(question.respond(wrong), AgentEngineError);
    }
    assert.deepEqual(answers, []);
    await question.respond({ [id]: ["Green"] });
  }
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "2" } }]);
  await engine.close();
});

test("two options with the same name can each be chosen", async () => {
  const options = [
    { optionId: "1", name: "Same", kind: "allow_once" },
    { optionId: "2", name: "Same", kind: "allow_once" },
  ];
  const answers: unknown[] = [];
  const { engine } = engineWith({ "session/prompt": questionPrompt(answers, options) });
  const thread = await engine.startThread({ cwd: CWD, access: "ask" });
  const [question] = await askAndAnswer(thread, (asked) => ({ [asked.questions[0]!.id]: [asked.questions[0]!.options[1]!.label] }));
  assert.deepEqual(question?.questions[0]?.options.map((option) => option.label), ["Same", "Same (2)"]);
  assert.deepEqual(answers, [{ outcome: { outcome: "selected", optionId: "2" } }]);
  await engine.close();
});

test("interrupt() cancels a question nobody has answered", async () => {
  const answers: unknown[] = [];
  const { engine, agent } = engineWith({
    "session/prompt": async (params, server) => {
      answers.push(await server.ask("session/request_permission", { sessionId: params.sessionId, toolCall: QUESTION_CALL, options: QUESTION_OPTIONS }));
      return { stopReason: "cancelled" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD, access: "full" });
  const turn = thread.run("Ask me");
  for await (const event of turn) {
    if (event.type === "request") await turn.interrupt();
  }
  assert.equal((await turn.result).status, "interrupted");
  assert.equal(agent().notifications("session/cancel").length, 1);
  assert.deepEqual(answers, [{ outcome: { outcome: "cancelled" } }]);
  await engine.close();
});

const ALLOW_A = { optionId: "a", name: "Allow A", kind: "allow_once" };
const ALLOW_B = { optionId: "b", name: "Allow B", kind: "allow_once" };
const ALWAYS = { optionId: "always", name: "Always", kind: "allow_always" };
const REJECT = { optionId: "no", name: "No", kind: "reject_once" };
const BARE_CALL = { toolCallId: "call-1", title: "Do it", rawInput: {} };

/** What must stay an approval, with what `full` and `read-only` answer on their own (null: cancelled). */
const APPROVALS: Array<{ name: string; options: unknown[]; toolCall?: Record<string, unknown>; announced?: Record<string, unknown>; full: string; readOnly: string | null }> = [
  {
    name: "Antigravity's real command approval",
    options: [{ optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    toolCall: { toolCallId: "3480cb8f", kind: "execute", status: "pending", title: "echo hello", rawInput: { CommandLine: "echo hello" } },
    full: "allow",
    readOnly: "deny",
  },
  { name: "the usual allow and reject", options: [ALLOW_A, REJECT], full: "a", readOnly: "no" },
  { name: "several ways to allow beside a reject", options: [ALLOW_A, ALLOW_B, REJECT], full: "a", readOnly: "no" },
  { name: "allow once and always with no reject", options: [ALLOW_A, ALWAYS], full: "a", readOnly: null },
  { name: "one option", options: [ALLOW_A], full: "a", readOnly: null },
  { name: "a tool kind", options: [ALLOW_A, ALLOW_B], toolCall: { ...BARE_CALL, kind: "execute" }, full: "a", readOnly: null },
  { name: "the explicit kind other", options: [ALLOW_A, ALLOW_B], toolCall: { ...BARE_CALL, kind: "other" }, full: "a", readOnly: null },
  { name: "tool input", options: [ALLOW_A, ALLOW_B], toolCall: { ...BARE_CALL, rawInput: { path: "x" } }, full: "a", readOnly: null },
  { name: "locations", options: [ALLOW_A, ALLOW_B], toolCall: { ...BARE_CALL, locations: [{ path: "x" }] }, full: "a", readOnly: null },
  { name: "content", options: [ALLOW_A, ALLOW_B], toolCall: { ...BARE_CALL, content: [{ type: "diff", path: "x", newText: "y" }] }, full: "a", readOnly: null },
  { name: "a kind announced earlier and not repeated", options: [ALLOW_A, ALLOW_B], toolCall: { toolCallId: "call-1", title: "Do it" }, announced: { ...BARE_CALL, kind: "edit" }, full: "a", readOnly: null },
  { name: "input announced earlier and not repeated", options: [ALLOW_A, ALLOW_B], toolCall: { toolCallId: "call-1", title: "Do it", kind: null, rawInput: null }, announced: { ...BARE_CALL, rawInput: { command: "ls" } }, full: "a", readOnly: null },
  { name: "no title", options: [ALLOW_A, ALLOW_B], toolCall: { toolCallId: "call-1", rawInput: {} }, full: "a", readOnly: null },
];

for (const { name, options, toolCall = BARE_CALL, announced = toolCall, full, readOnly } of APPROVALS) {
  test(`a request with ${name} stays an approval at every access level`, async () => {
    const run = async (access: "ask" | "full" | "read-only") => {
      const answers: unknown[] = [];
      const { engine } = engineWith({ "session/prompt": questionPrompt(answers, options, toolCall, announced) });
      const thread = await engine.startThread({ cwd: CWD, access });
      const surfaced: AgentRequest[] = [];
      for await (const event of thread.run("Do it")) {
        if (event.type !== "request") continue;
        surfaced.push(event.request);
        assert.equal(event.request.kind, "approval");
        await (event.request as ApprovalRequest).respond({ decision: "allow" });
      }
      await engine.close();
      return { surfaced, answers };
    };
    const selected = (optionId: string | null) => (optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });

    const ask = await run("ask");
    assert.deepEqual(ask.surfaced.map((request) => request.kind), ["approval"]);
    assert.deepEqual(ask.answers, [selected(full)]);

    const allowed = await run("full");
    assert.deepEqual(allowed.surfaced, []);
    assert.deepEqual(allowed.answers, [selected(full)]);

    const refused = await run("read-only");
    assert.deepEqual(refused.surfaced, []);
    assert.deepEqual(refused.answers, [selected(readOnly)]);
  });
}

test("run() with mode plan switches the session to its plan mode with session/set_mode", async () => {
  const { engine, agent } = engineWith();
  const thread = await engine.startThread({ cwd: CWD });
  await thread.run("Plan the change", { mode: "plan" }).result;
  assert.deepEqual(agent().requests("session/set_mode"), [{ sessionId: "sess-1", modeId: "plan" }]);
  await engine.close();
});

test("resumeThread() loads the session and its replayed turn becomes history, not live events", async () => {
  const { engine, agent } = engineWith({
    "session/load": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier question" } });
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier answer" } });
      return {};
    },
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New answer" } });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.resumeThread("sess-saved", { cwd: CWD });
  assert.deepEqual(agent().requests("session/load"), [{ sessionId: "sess-saved", cwd: CWD, mcpServers: [] }]);
  assert.deepEqual((await thread.history()).map((turn) => turn.entries), [[
    { kind: "message", role: "user", text: "Earlier question" },
    { kind: "message", role: "assistant", text: "Earlier answer" },
  ]]);

  const turn = thread.run("Follow-up");
  const events = await drain(turn);
  assert.deepEqual(ofType(events, "text.delta").map((event) => event.delta), ["New answer"]);
  assert.equal((await thread.history()).length, 2);
  await engine.close();
});

test("replayed turns stay separate when a user message follows an agent reply", async () => {
  const { engine } = engineWith({
    "session/load": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First question" } });
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First answer" } });
      server.update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second question" } });
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second answer" } });
      return {};
    },
  });
  const thread = await engine.resumeThread("sess-saved", { cwd: CWD });
  assert.deepEqual((await thread.history()).map((turn) => turn.entries), [
    [{ kind: "message", role: "user", text: "First question" }, { kind: "message", role: "assistant", text: "First answer" }],
    [{ kind: "message", role: "user", text: "Second question" }, { kind: "message", role: "assistant", text: "Second answer" }],
  ]);
  await engine.close();
});

test("forkThread() sends session/fork for the source session", async () => {
  const { engine, agent } = engineWith({ "session/fork": () => ({ sessionId: "sess-fork" }) });
  const thread = await engine.forkThread("sess-1", { cwd: CWD });
  assert.equal(thread.id, "sess-fork");
  assert.deepEqual(agent().requests("session/fork"), [{ sessionId: "sess-1", cwd: CWD, mcpServers: [] }]);
  await engine.close();
});

test("forkThread() with throughTurnId throws UnsupportedFeatureError", async () => {
  const { engine } = engineWith();
  await assert.rejects(engine.forkThread("sess-1", { cwd: CWD, throughTurnId: "turn-2" }), UnsupportedFeatureError);
  await engine.close();
});

test("listThreads() maps session/list results and filters by search", async () => {
  const { engine } = engineWith({
    "session/list": () => ({
      sessions: [
        { sessionId: "s-1", cwd: CWD, title: "Fix the parser", updatedAt: "2026-10-01T09:00:00Z" },
        { sessionId: "s-2", cwd: CWD, title: "Write the changelog", updatedAt: "2026-10-02T09:00:00Z" },
      ],
    }),
  });
  const all = await engine.listThreads();
  assert.deepEqual(all.map((thread) => thread.id), ["s-1", "s-2"]);
  assert.equal(all[0]!.title, "Fix the parser");
  assert.ok(all[1]!.updatedAt instanceof Date);
  assert.equal(all[1]!.updatedAt?.toISOString(), "2026-10-02T09:00:00.000Z");
  assert.deepEqual((await engine.listThreads({ search: "parser" })).map((thread) => thread.id), ["s-1"]);
  await engine.close();
});

test("a text file attached to a turn is sent as an embedded resource with its text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-engine-"));
  const file = join(dir, "notes.txt");
  try {
    await writeFile(file, "Line one\nLine two\n");
    const { engine, agent } = engineWith();
    const thread = await engine.startThread({ cwd: CWD });
    await thread.run({ text: "Summarise the file", files: [{ type: "path", path: file }] }).result;
    assert.deepEqual(agent().requests("session/prompt")[0]!.prompt, [
      { type: "text", text: "Summarise the file" },
      { type: "resource", resource: { uri: `file://${file}`, mimeType: "text/plain", text: "Line one\nLine two\n" } },
    ]);
    await engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("export() returns the turns recorded on the thread", async () => {
  const { engine } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello there" } });
      return { stopReason: "end_turn" };
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  await thread.run("Hi").result;
  const transcript = await thread.export();
  assert.equal(transcript.provider, "acp");
  assert.equal(transcript.threadId, thread.id);
  assert.deepEqual(transcript.turns.map((turn) => turn.entries), [[
    { kind: "message", role: "user", text: "Hi" },
    { kind: "message", role: "assistant", text: "Hello there" },
  ]]);
  await engine.close();
});

test("a thread seeded with earlier turns puts them before the first prompt only", async () => {
  const seed: PortableTranscript = {
    provider: "claude",
    threadId: "old-thread",
    turns: [{
      id: "old-thread:0",
      status: "completed",
      entries: [
        { kind: "message", role: "user", text: "Name the file" },
        { kind: "message", role: "assistant", text: "It is notes.txt" },
      ],
    }],
  };
  const { engine, agent } = engineWith();
  const thread = await engine.startThread({ cwd: CWD, seed });
  await thread.run("And its size?").result;
  await thread.run("Thanks").result;
  const [first, second] = agent().requests("session/prompt").map((params) => params.prompt[0].text as string);
  assert.match(first!, /<earlier-conversation>[\s\S]*Name the file[\s\S]*It is notes\.txt[\s\S]*<\/earlier-conversation>[\s\S]*And its size\?$/u);
  assert.equal(second, "Thanks");
  await engine.close();
});

test("the agent process exiting mid-turn fails the turn with kind connection", async () => {
  const { engine, agent } = engineWith({
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it" } });
      return NO_REPLY;
    },
  });
  const thread = await engine.startThread({ cwd: CWD });
  const turn = thread.run("Do the work");
  await until(() => agent().requests("session/prompt").length === 1);
  agent().exit();
  const result = await turn.result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "connection");
  await engine.close();
});

test("after the agent restarts, a session reloaded with session/load still streams the next turn", async () => {
  const { spawn, children } = fakeAcpSpawner({
    // No session/resume, so the engine reloads the session, which replays it.
    initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "load-only", version: "0.1.0" } }),
    "session/load": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First" } });
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First answer" } });
      return {};
    },
    "session/prompt": (params, server) => {
      server.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second answer" } });
      return { stopReason: "end_turn" };
    },
  });
  const engine = new AcpEngine({ command: "fake-agent", cwd: CWD, spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: CWD });
  await thread.run("First").result;
  children[0]!.exit();
  await until(() => children[0]!.exited);
  await new Promise((resolve) => setImmediate(resolve));
  const turn = thread.run("Second");
  const events = await drain(turn);
  assert.equal(children.length, 2);
  assert.deepEqual(ofType(events, "text.delta").map((event) => event.delta), ["Second answer"]);
  assert.equal((await turn.result).text, "Second answer");
  const history = await thread.history();
  assert.deepEqual(history[history.length - 1]!.entries, [
    { kind: "message", role: "user", text: "Second" },
    { kind: "message", role: "assistant", text: "Second answer" },
  ]);
  await engine.close();
});

test("a late tool update after the call finished emits nothing", () => {
  const normalizer = new AcpNormalizer("sess-1");
  normalizer.startTurn("turn-1", "");
  normalizer.normalize({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run", kind: "execute", status: "in_progress" });
  const done = normalizer.normalize({
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
  });
  assert.deepEqual(done.map((event) => event.type), ["tool.completed"]);
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" }), []);
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "tool_call_update", toolCallId: "c1", content: [{ type: "content", content: { type: "text", text: "late" } }] }), []);
});

test("session_info_update becomes thread.renamed once per new title", () => {
  const normalizer = new AcpNormalizer("sess-1");
  normalizer.startTurn("turn-1", "");
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "session_info_update", title: "Parser fixes" }), [
    { threadId: "sess-1", turnId: "turn-1", type: "thread.renamed", title: "Parser fixes" },
  ]);
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "session_info_update", title: "Parser fixes" }), []);
  assert.equal(normalizer.title, "Parser fixes");
});

test("usage_update feeds the normalizer's context figures", () => {
  const normalizer = new AcpNormalizer("sess-1");
  normalizer.startTurn("turn-1", "");
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "usage_update", used: 1200, size: 8000 }), []);
  assert.deepEqual(normalizer.context, { used: 1200, size: 8000 });
});

test("replayed updates are recorded as history and emit no events", () => {
  const normalizer = new AcpNormalizer("sess-1");
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Old question" } }, true), []);
  assert.deepEqual(normalizer.normalize({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old answer" } }, true), []);
  normalizer.endReplay();
  assert.deepEqual(normalizer.turns.map((turn) => turn.entries), [[
    { kind: "message", role: "user", text: "Old question" },
    { kind: "message", role: "assistant", text: "Old answer" },
  ]]);
});

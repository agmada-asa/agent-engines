/** @file The Codex engine end to end against a fake app-server: threads, turns, steer, interrupt, compact, requests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexEngine } from "../src/codex/engine.ts";
import { RuntimeAuthError, RuntimeModelSubstitutionError, SteerRejectedError } from "../src/errors.ts";
import type { AgentEvent } from "../src/types.ts";
import { FakeAppServer, fakeSpawner, until } from "./fake-app-server.ts";

const THREAD = "019a-thread";

/** Handlers for a well-behaved app-server; `turn/start` replies and the test drives the turn. */
function handlers(extra: Record<string, (params: any, server: FakeAppServer) => unknown> = {}) {
  let turns = 0;
  return {
    "model/list": () => ({
      data: [{
        id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", description: "Fast", hidden: false, isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }],
        defaultReasoningEffort: "low", inputModalities: ["text", "image"], serviceTiers: [{ id: "priority", name: "Fast", description: "" }],
      }],
      nextCursor: null,
    }),
    "thread/start": (params: any) => ({ thread: { id: THREAD }, model: params.model ?? "gpt-6-luna" }),
    "thread/resume": (params: any) => ({ thread: { id: params.threadId }, model: params.model ?? "gpt-6-luna" }),
    "turn/start": (_params: any, server: FakeAppServer) => {
      turns += 1;
      const id = `turn-${turns}`;
      queueMicrotask(() => server.notify("turn/started", { threadId: THREAD, turn: { id, items: [], status: "inProgress" } }));
      return { turn: { id, items: [], status: "inProgress" } };
    },
    "turn/steer": (params: any) => ({ turnId: params.expectedTurnId }),
    "turn/interrupt": (params: any, server: FakeAppServer) => {
      queueMicrotask(() => server.notify("turn/completed", { threadId: THREAD, turn: { id: params.turnId, status: "interrupted", items: [], error: null } }));
      return {};
    },
    "thread/compact/start": (_params: any, server: FakeAppServer) => {
      queueMicrotask(() => {
        server.notify("turn/started", { threadId: THREAD, turn: { id: "compact-1", items: [], status: "inProgress" } });
        server.notify("item/completed", { threadId: THREAD, turnId: "compact-1", item: { type: "contextCompaction", id: "cc" } });
        server.notify("turn/completed", { threadId: THREAD, turn: { id: "compact-1", status: "completed", items: [], error: null } });
      });
      return {};
    },
    "thread/delete": () => ({}),
    ...extra,
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("models() maps the catalogue, including fast mode", async () => {
  const { spawn } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  assert.deepEqual(await engine.models(), [{
    id: "gpt-6-luna", label: "GPT-6 Luna", description: "Fast", efforts: ["low", "high"], defaultEffort: "low",
    fastMode: true, isDefault: false, hidden: false, inputModalities: ["text", "image"],
  }]);
  await engine.close();
});

test("a thread starts with mapped options, runs a turn and streams normalised events", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({
    cwd: "/tmp/work", model: "gpt-6-luna", effort: "low", fastMode: true, access: "full", instructions: "Be brief.",
    mcpServers: { ocean: { command: "/usr/bin/node", args: ["mcp.js"], env: { A: "1" } }, remote: { type: "http", url: "https://x.test/mcp" } },
  });
  assert.equal(thread.id, THREAD);
  const server = children[0];
  const start = server.requests("thread/start")[0];
  assert.equal(start.cwd, "/tmp/work");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.sandbox, "danger-full-access");
  assert.equal(start.developerInstructions, "Be brief.");
  assert.equal(start.serviceTier, "priority");
  assert.equal(start.allowProviderModelFallback, false);
  assert.deepEqual(start.config.mcp_servers, { ocean: { command: "/usr/bin/node", args: ["mcp.js"], env: { A: "1" } }, remote: { url: "https://x.test/mcp" } });

  const turn = thread.run({ text: "Say hi", images: [{ type: "path", path: "/tmp/a.png" }] });
  const events = collect(turn);
  assert.equal(await turn.id, "turn-1");
  const turnStart = server.requests("turn/start")[0];
  assert.deepEqual(turnStart.input, [{ type: "text", text: "Say hi", text_elements: [] }, { type: "localImage", path: "/tmp/a.png" }]);
  assert.equal(turnStart.effort, "low");
  await until(() => thread.activeTurn !== undefined);
  server.notify("item/agentMessage/delta", { threadId: THREAD, turnId: "turn-1", itemId: "m", delta: "Hi" });
  server.notify("item/completed", { threadId: THREAD, turnId: "turn-1", item: { type: "agentMessage", id: "m", text: "Hi there" } });
  server.notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed", items: [], error: null } });
  const result = await turn.result;
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hi there");
  assert.deepEqual((await events).map((event) => event.type), ["turn.started", "text.delta", "text.done", "turn.completed"]);
  assert.equal(thread.activeTurn, undefined);
  await engine.close();
});

test("steer adds input to the running turn; after the turn ends it is rejected", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Start");
  await turn.id;
  await turn.steer("Also do this");
  const steer = children[0].requests("turn/steer")[0];
  assert.deepEqual(steer, { threadId: THREAD, input: [{ type: "text", text: "Also do this", text_elements: [] }], expectedTurnId: "turn-1" });
  children[0].notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed", items: [], error: null } });
  await turn.result;
  await assert.rejects(turn.steer("late"), SteerRejectedError);
  await engine.close();
});

test("a steer the runtime refuses throws SteerRejectedError", async () => {
  const { spawn } = fakeSpawner(handlers({ "turn/steer": () => new Error("active turn is not steerable") }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Start");
  await turn.id;
  await assert.rejects(turn.steer("x"), SteerRejectedError);
  await engine.close();
});

test("interrupt ends the turn as interrupted", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Long task");
  await turn.interrupt();
  const result = await turn.result;
  assert.equal(result.status, "interrupted");
  assert.deepEqual(children[0].requests("turn/interrupt")[0], { threadId: THREAD, turnId: "turn-1" });
  await engine.close();
});

test("compact runs as its own turn and reports compaction", async () => {
  const { spawn } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.compact();
  const events = await collect(turn);
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "compacted", "turn.completed"]);
  assert.equal((await turn.result).turnId, "compact-1");
  await engine.close();
});

test("approval and question requests surface as events and answer the server", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp", access: "ask" });
  assert.equal(children[0].requests("thread/start")[0].approvalPolicy, "on-request");
  const turn = thread.run("Do it");
  await turn.id;
  const seen: AgentEvent[] = [];
  thread.subscribe((event) => {
    seen.push(event);
    if (event.type !== "request") return;
    if (event.request.kind === "approval") void event.request.respond({ decision: "allow" });
    if (event.request.kind === "question") void event.request.respond({ q: ["Yes"] });
  });
  const approval = await children[0].ask("item/commandExecution/requestApproval", { threadId: THREAD, turnId: "turn-1", itemId: "c", command: "npm test" });
  assert.deepEqual(approval, { decision: "accept" });
  const answer = await children[0].ask("item/tool/requestUserInput", { threadId: THREAD, turnId: "turn-1", itemId: "q", isBlocking: true, questions: [{ id: "q", header: "", question: "Go?", isOther: false, isSecret: false, options: null }] });
  assert.deepEqual(answer, { answers: { q: { answers: ["Yes"] } } });
  assert.equal(seen.filter((event) => event.type === "request").length, 2);
  await engine.close();
});

test("an unanswered request is cancelled when the turn ends", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Do it");
  await turn.id;
  const pending = children[0].ask("item/fileChange/requestApproval", { threadId: THREAD, turnId: "turn-1", itemId: "f" });
  await until(() => children[0].received.length > 0 && thread.activeTurn !== undefined);
  children[0].notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "interrupted", items: [], error: null } });
  assert.deepEqual(await pending, { decision: "cancel" });
  await engine.close();
});

test("host tool calls go to onToolCall", async () => {
  const calls: unknown[] = [];
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({
    spawnProcess: spawn,
    onToolCall: async (call) => {
      calls.push(call);
      return { text: "42", success: true };
    },
  });
  await engine.startThread({ cwd: "/tmp", codex: { dynamicTools: [{ name: "answer", description: "The answer", inputSchema: { type: "object" } }] } });
  assert.equal(children[0].requests("thread/start")[0].dynamicTools[0].name, "answer");
  const result = await children[0].ask("item/tool/call", { threadId: THREAD, turnId: "t", callId: "c1", tool: "answer", namespace: null, arguments: { q: 1 } });
  assert.deepEqual(result, { contentItems: [{ type: "inputText", text: "42" }], success: true });
  assert.deepEqual(calls, [{ threadId: THREAD, turnId: "t", callId: "c1", tool: "answer", namespace: null, arguments: { q: 1 } }]);
  await engine.close();
});

test("a usage limit fails the turn with its reset time", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Hi");
  await turn.id;
  children[0].notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null, rateLimitReachedType: "primary" } });
  children[0].notify("error", { threadId: THREAD, turnId: "turn-1", willRetry: false, error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" } });
  children[0].notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "failed", items: [], error: null } });
  const result = await turn.result;
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "usage-limit");
  assert.equal(result.error?.resetsAt?.getTime(), 1800000000 * 1000);
  await engine.close();
});

test("a crash fails the running turn; the next turn starts a fresh child and resumes the thread", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp", model: "gpt-6-luna" });
  const turn = thread.run("Hi");
  await turn.id;
  children[0].exit();
  const failed = await turn.result;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.kind, "connection");
  const next = thread.run("Again");
  await next.id;
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].requests("thread/resume")[0].threadId, THREAD);
  await engine.close();
});

test("resumeThread resumes by ID and a different model is refused", async () => {
  const { spawn } = fakeSpawner(handlers({ "thread/resume": (params: any) => ({ thread: { id: params.threadId }, model: "gpt-6-sol" }) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  await assert.rejects(engine.resumeThread("saved", { cwd: "/tmp", model: "gpt-6-luna" }), RuntimeModelSubstitutionError);
  const thread = await engine.resumeThread("saved", { cwd: "/tmp", model: "gpt-6-luna", strictModel: false });
  assert.equal(thread.id, "saved");
  await engine.close();
});

test("an API-key sign-in is refused unless allowed, and keys are stripped from the child", async () => {
  const env: NodeJS.ProcessEnv[] = [];
  const { spawn: inner } = fakeSpawner(handlers({ "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }) }));
  const spawn: typeof inner = (command, args, options) => {
    env.push(options.env);
    return inner(command, args, options);
  };
  const strict = new CodexEngine({ spawnProcess: spawn, env: { PATH: "/bin", OPENAI_API_KEY: "sk-x" } });
  await assert.rejects(strict.startThread({ cwd: "/tmp" }), RuntimeAuthError);
  const availability = await strict.availability();
  assert.equal(availability.ready, false);
  assert.equal(availability.reason, "api-key");
  assert.equal(env[0].OPENAI_API_KEY, undefined);
  const relaxed = new CodexEngine({ spawnProcess: spawn, requireSubscription: false, env: { PATH: "/bin", OPENAI_API_KEY: "sk-x" } });
  assert.equal((await relaxed.availability()).ready, true);
  assert.equal(env.at(-1)!.OPENAI_API_KEY, "sk-x");
  await strict.close();
  await relaxed.close();
});

test("availability reports a signed-in subscription, and signed-out", async () => {
  const { spawn } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const ready = await engine.availability();
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.account, { kind: "subscription", plan: "plus", email: "someone@example.com" });
  await engine.close();
  const { spawn: signedOut } = fakeSpawner(handlers({ "account/read": () => ({ account: null, requiresOpenaiAuth: true }) }));
  const out = new CodexEngine({ spawnProcess: signedOut });
  assert.equal((await out.availability()).reason, "signed-out");
  await out.close();
});

test("deleteThread deletes the thread and the subagents it saw", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const turn = thread.run("Spawn");
  await turn.id;
  children[0].notify("item/completed", {
    threadId: THREAD, turnId: "turn-1",
    item: { type: "collabAgentToolCall", id: "s", tool: "spawnAgent", status: "completed", senderThreadId: THREAD, receiverThreadIds: ["child-9"], prompt: "p", model: null, reasoningEffort: null, agentsStates: {} },
  });
  await until(() => thread.subscribe !== undefined);
  children[0].notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed", items: [], error: null } });
  await turn.result;
  await engine.deleteThread(THREAD, { cwd: "/tmp" });
  assert.deepEqual(children[0].requests("thread/delete").map((params) => params.threadId), ["child-9", THREAD]);
  await engine.close();
});

test("run() while a turn is active throws", async () => {
  const { spawn } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  thread.run("one");
  assert.throws(() => thread.run("two"), /already running/);
  await engine.close();
});

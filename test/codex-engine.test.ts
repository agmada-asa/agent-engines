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

test("usage() maps each rate limit bucket's windows by their length", async () => {
  const window = (usedPercent: number, minutes: number, resetsAt: number) => ({ usedPercent, windowDurationMins: minutes, resetsAt });
  const snapshot = (limitId: string, primary: unknown, secondary: unknown, extra: Record<string, unknown> = {}) => ({
    limitId, limitName: null, normalModelSlug: null, primary, secondary, credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null, ...extra,
  });
  const { spawn } = fakeSpawner({
    "account/rateLimits/read": () => ({
      ordinaryUsageAllowed: true,
      rateLimits: snapshot("codex", window(100, 300, 1_792_000_000), window(31, 10_080, 1_793_000_000)),
      rateLimitsByLimitId: {
        codex: snapshot("codex", window(100, 300, 1_792_000_000), window(31, 10_080, 1_793_000_000)),
        "gpt-6-sol": snapshot("gpt-6-sol", null, window(5, 10_080, 1_793_000_000), { normalModelSlug: "gpt-6-sol" }),
      },
      rateLimitResetCredits: { availableCount: 2, credits: null },
      accountId: null,
      rateLimitUpsell: null,
    }),
  });
  const engine = new CodexEngine({ spawnProcess: spawn });
  const report = await engine.usage();
  assert.equal(report.plan, "plus");
  assert.equal(report.available, true);
  assert.equal(report.resetCredits, 2);
  assert.deepEqual(report.windows, [
    { kind: "session", name: "codex", usedPercent: 100, resetsAt: new Date(1_792_000_000_000) },
    { kind: "weekly", name: "codex", usedPercent: 31, resetsAt: new Date(1_793_000_000_000) },
    { kind: "weekly", name: "gpt-6-sol", model: "gpt-6-sol", usedPercent: 5, resetsAt: new Date(1_793_000_000_000) },
  ]);
  await engine.close();
});

test("commands() lists the folder's enabled skills after /compact", async () => {
  const { spawn, children } = fakeSpawner({
    "skills/list": () => ({
      data: [{
        cwd: "/tmp/work",
        errors: [],
        skills: [
          { name: "pdf:pdf", description: "Long description.", interface: { shortDescription: "Read PDFs", iconSmallUrl: null, iconLargeUrl: null }, path: "/s/pdf", scope: "user", enabled: true, pluginId: "pdf" },
          { name: "off", description: "Disabled", path: "/s/off", scope: "user", enabled: false, pluginId: null },
        ],
      }],
    }),
  });
  const engine = new CodexEngine({ spawnProcess: spawn });
  assert.deepEqual(await engine.commands({ cwd: "/tmp/work" }), [
    { name: "compact", kind: "command", description: "Compact the conversation's context.", builtin: true },
    { name: "pdf:pdf", kind: "skill", description: "Read PDFs" },
  ]);
  assert.deepEqual(children[0].requests("skills/list")[0], { cwds: ["/tmp/work"] });
  await engine.close();
});

test("a thread starts with mapped options, runs a turn and streams normalised events", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({
    cwd: "/tmp/work", model: "gpt-6-luna", effort: "low", fastMode: true, access: "full", instructions: "Be brief.",
    mcpServers: { notes: { command: "/usr/bin/node", args: ["mcp.js"], env: { A: "1" } }, remote: { type: "http", url: "https://x.test/mcp" } },
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
  assert.deepEqual(start.config.mcp_servers, { notes: { command: "/usr/bin/node", args: ["mcp.js"], env: { A: "1" } }, remote: { url: "https://x.test/mcp" } });

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
  const thread = await engine.startThread({ cwd: "/tmp", access: "ask", codex: { approvalsReviewer: "user" } });
  assert.equal(children[0].requests("thread/start")[0].approvalPolicy, "on-request");
  assert.equal(children[0].requests("thread/start")[0].approvalsReviewer, "user");
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
  children[0].notify("item/started", { threadId: THREAD, turnId: "turn-1", item: { type: "fileChange", id: "f", status: "inProgress", changes: [{ path: "/tmp/x", kind: { type: "add" }, diff: "x" }] } });
  const files = await children[0].ask("item/fileChange/requestApproval", { threadId: THREAD, turnId: "turn-1", itemId: "f" });
  assert.deepEqual(files, { decision: "accept" });
  const fileRequest = seen.find((event) => event.type === "request" && event.request.kind === "approval" && event.request.action === "file-change");
  assert.deepEqual((fileRequest as any).request.changes, [{ path: "/tmp/x", kind: "add", diff: "@@ -0,0 +1,1 @@\n+x" }]);
  const answer = await children[0].ask("item/tool/requestUserInput", { threadId: THREAD, turnId: "turn-1", itemId: "q", isBlocking: true, questions: [{ id: "q", header: "", question: "Go?", isOther: false, isSecret: false, options: null }] });
  assert.deepEqual(answer, { answers: { q: { answers: ["Yes"] } } });
  assert.equal(seen.filter((event) => event.type === "request").length, 3);
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

test("deleteThread finds subagents from earlier runs through thread/list", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "thread/list": (params: any) => ({ data: params.archived ? [{ id: "old-2" }] : [{ id: "old-1" }], nextCursor: null, backwardsCursor: null, readStates: null }),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  await engine.deleteThread("saved-thread", { cwd: "/tmp" });
  assert.deepEqual(children[0].requests("thread/list").map((params) => params.ancestorThreadId), ["saved-thread", "saved-thread"]);
  assert.deepEqual(children[0].requests("thread/delete").map((params) => params.threadId), ["old-1", "old-2", "saved-thread"]);
  await engine.close();
});

test("lastTurn reads the latest turn's status and reply from Codex", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "thread/turns/list": () => ({
      data: [{ id: "turn-7", status: "interrupted", items: [{ type: "agentMessage", id: "m1", text: "Partial" }, { type: "commandExecution", id: "c1" }], error: null }],
      nextCursor: null, backwardsCursor: null,
    }),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.resumeThread(THREAD, { cwd: "/tmp" });
  assert.deepEqual(await thread.lastTurn(), { turnId: "turn-7", status: "interrupted", text: "Partial" });
  assert.deepEqual(children[0].requests("thread/turns/list")[0], { threadId: THREAD, sortDirection: "desc", limit: 1, itemsView: "full" });
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

test("the app-server runs in the engine's cwd and reports MCP servers before any thread", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "mcpServerStatus/list": () => ({ data: [{ name: "geo", tools: { search: {} }, runtimeStatus: "ready" }], nextCursor: null }),
  }));
  const cwds: string[] = [];
  const engine = new CodexEngine({ cwd: "/tmp/job", spawnProcess: (command, args, options) => (cwds.push(options.cwd), spawn(command, args, options)) });
  assert.deepEqual(await engine.mcpStatus(), [{ name: "geo", status: "ready", tools: ["search"] }]);
  assert.deepEqual(cwds, ["/tmp/job"]);
  assert.equal(children[0].requests("mcpServerStatus/list")[0].threadId, undefined);
  assert.equal(children[0].requests("thread/start").length, 0);
  await engine.close();
});

test("networkAccess reasserts the sandbox and approval policy on every turn", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const locked = await engine.startThread({ cwd: "/tmp", access: "read-only", codex: { networkAccess: false } });
  await locked.run("Hi").id;
  const turn = children[0].requests("turn/start")[0];
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.approvalPolicy, "never");
  await locked.close();
  const plain = await engine.startThread({ cwd: "/tmp", access: "read-only" });
  await plain.run("Hi").id;
  const second = children[0].requests("turn/start")[1];
  assert.equal(second.sandboxPolicy, undefined);
  assert.equal(second.approvalPolicy, undefined);
  await engine.close();
});

test("interruptTurn stops a turn by ID that this thread object did not start", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.resumeThread("saved", { cwd: "/tmp" });
  await thread.interruptTurn("turn-from-before");
  assert.deepEqual(children[0].requests("turn/interrupt")[0], { threadId: "saved", turnId: "turn-from-before" });
  await engine.close();
});

test("live progress reaches the turn, and the reply text stays the final answer", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/tmp" });
  const seen: AgentEvent[] = [];
  thread.subscribe((event) => seen.push(event));
  const turn = thread.run("Build it");
  const events = collect(turn);
  await turn.id;
  await until(() => thread.activeTurn !== undefined);
  const server = children[0];
  server.notify("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: [] } });
  server.notify("turn/plan/updated", { threadId: THREAD, turnId: "turn-1", explanation: null, plan: [{ step: "Build", status: "inProgress" }] });
  server.notify("item/completed", { threadId: THREAD, turnId: "turn-1", item: { type: "agentMessage", id: "c", text: "Building now.", phase: "commentary" } });
  server.notify("item/started", { threadId: THREAD, turnId: "turn-1", item: { type: "commandExecution", id: "cmd", command: "npm run build", cwd: "/tmp", status: "inProgress" } });
  server.notify("item/commandExecution/outputDelta", { threadId: THREAD, turnId: "turn-1", itemId: "cmd", delta: "> tsc\n" });
  server.notify("item/commandExecution/outputDelta", { threadId: THREAD, turnId: "turn-1", itemId: "cmd", delta: "done\n" });
  server.notify("item/completed", { threadId: THREAD, turnId: "turn-1", item: { type: "commandExecution", id: "cmd", command: "npm run build", cwd: "/tmp", status: "completed", aggregatedOutput: "> tsc\ndone\n", exitCode: 0 } });
  server.notify("turn/diff/updated", { threadId: THREAD, turnId: "turn-1", diff: "diff --git a/x b/x\n" });
  server.notify("item/completed", { threadId: THREAD, turnId: "turn-1", item: { type: "agentMessage", id: "a", text: "Built.", phase: "final_answer" } });
  server.notify("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed", items: [], error: null } });
  server.notify("thread/status/changed", { threadId: THREAD, status: { type: "idle" } });
  const result = await turn.result;
  assert.equal(result.text, "Built.");
  const types = (await events).map((event) => event.type);
  assert.deepEqual(types, [
    "turn.started", "status", "plan.updated", "text.done", "tool.started", "tool.output.delta", "tool.output.delta",
    "tool.completed", "diff.updated", "text.done", "turn.completed",
  ]);
  // The idle status arrives after the turn, so only thread subscribers see it.
  await until(() => seen.at(-1)?.type === "status");
  assert.deepEqual(seen.at(-1), { threadId: THREAD, turnId: "", type: "status", status: { state: "idle" } });
  await engine.close();
});

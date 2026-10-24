/**
 * @file The Codex engine's thread history, modes, structured output, goals,
 * review, tasks, MCP controls, sign-in and handoff, against a fake app-server.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CodexEngine } from "../src/codex/engine.ts";
import { UnsupportedFeatureError } from "../src/errors.ts";
import type { AgentEvent, EngineEvent } from "../src/types.ts";
import { FakeAppServer, fakeSpawner, until } from "./fake-app-server.ts";

const THREAD = "019a-thread";

/** A thread record as `thread/list` and `thread/read` return it. */
function threadRecord(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, cwd: "/work", name: null, preview: "Fix the tests", createdAt: 1_790_000_000, updatedAt: 1_790_000_600, forkedFromId: null,
    model: "gpt-6-luna", gitInfo: { branch: "main" }, turns: [], ...extra,
  };
}

/** Handlers for a well-behaved app-server; `turn/start` replies and the test drives the turn. */
function handlers(extra: Record<string, (params: any, server: FakeAppServer) => unknown> = {}) {
  let turns = 0;
  return {
    "thread/start": (params: any) => ({ thread: { id: THREAD }, model: params.model ?? "gpt-6-luna" }),
    "thread/resume": (params: any) => ({ thread: { id: params.threadId }, model: params.model ?? "gpt-6-luna" }),
    "thread/fork": (params: any) => ({ thread: { id: `fork-of-${params.threadId}` }, model: params.model ?? "gpt-6-luna" }),
    "turn/start": (_params: any, server: FakeAppServer) => {
      turns += 1;
      const id = `turn-${turns}`;
      queueMicrotask(() => server.notify("turn/started", { threadId: THREAD, turn: { id, items: [], status: "inProgress" } }));
      return { turn: { id, items: [], status: "inProgress" } };
    },
    "thread/turns/list": () => ({
      data: [
        { id: "turn-1", status: "completed", startedAt: 1_790_000_000, items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "Add a test" }] },
          { type: "commandExecution", id: "c1", command: "npm test", cwd: "/work", aggregatedOutput: "ok", status: "completed" },
          { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/work/a.test.ts", kind: { type: "add" }, diff: "x" }] },
          { type: "agentMessage", id: "a1", text: "Added it." },
        ] },
        { id: "turn-2", status: "completed", items: [
          { type: "userMessage", id: "u2", content: [{ type: "text", text: "Thanks" }] },
          { type: "agentMessage", id: "a2", text: "Any time." },
        ] },
      ],
      nextCursor: null,
    }),
    ...extra,
  };
}

/** Finishes the running turn with `text` as its reply. */
function complete(server: FakeAppServer, turnId: string, text: string): void {
  server.notify("item/completed", { threadId: THREAD, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text } });
  server.notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed", items: [], error: null } });
}

test("capabilities() describes Codex", async () => {
  const engine = new CodexEngine({ spawnProcess: fakeSpawner().spawn });
  const capabilities = await engine.capabilities();
  assert.equal(capabilities.fork, true);
  assert.equal(capabilities.rewindFiles, false);
  assert.equal(capabilities.review, "native");
  assert.deepEqual(capabilities.modes, ["default", "plan"]);
  await engine.close();
});

test("forkThread forks through a turn with the new thread's settings", async () => {
  const { spawn, children } = fakeSpawner(handlers({ "thread/name/set": () => ({}) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const fork = await engine.forkThread(THREAD, { cwd: "/work", model: "gpt-6-luna", throughTurnId: "turn-1", title: "Try B" });
  assert.equal(fork.id, `fork-of-${THREAD}`);
  const [params] = children[0]!.requests("thread/fork");
  assert.equal(params.threadId, THREAD);
  assert.equal(params.lastTurnId, "turn-1");
  assert.equal(params.cwd, "/work");
  assert.equal(params.excludeTurns, true);
  assert.deepEqual(children[0]!.requests("thread/name/set"), [{ threadId: fork.id, name: "Try B" }]);
  await engine.close();
});

test("listThreads leaves subagents out and maps each thread", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "thread/list": () => ({ data: [threadRecord("t1", { name: "Tests" })], nextCursor: null }),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const [summary] = await engine.listThreads({ cwd: "/work", search: "test", limit: 5 });
  assert.deepEqual(summary, {
    id: "t1", provider: "codex", cwd: "/work", title: "Tests", preview: "Fix the tests",
    createdAt: new Date(1_790_000_000_000), updatedAt: new Date(1_790_000_600_000), model: "gpt-6-luna", gitBranch: "main", archived: false,
  });
  const [params] = children[0]!.requests("thread/list");
  assert.equal(params.cwd, "/work");
  assert.equal(params.searchTerm, "test");
  assert.ok(!params.sourceKinds.includes("subAgent"));
  await engine.close();
});

test("readThread and history() give each turn's entries, file changes included", async () => {
  const { spawn } = fakeSpawner(handlers({ "thread/read": () => ({ thread: threadRecord(THREAD), readState: null }) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const history = await engine.readThread(THREAD, { cwd: "/work" });
  assert.equal(history.turns.length, 2);
  assert.deepEqual(history.turns[0], {
    id: "turn-1",
    status: "completed",
    startedAt: new Date(1_790_000_000_000),
    entries: [
      { kind: "message", role: "user", text: "Add a test" },
      { kind: "tool", tool: { kind: "command", name: "shell", input: { command: "npm test", cwd: "/work" } }, output: "ok" },
      { kind: "files", changes: [{ path: "/work/a.test.ts", kind: "add" }] },
      { kind: "message", role: "assistant", text: "Added it." },
    ],
  });
  const thread = await engine.resumeThread(THREAD, { cwd: "/work" });
  assert.equal((await thread.export()).turns.length, 2);
  await engine.close();
});

test("rename, archive and unarchive call Codex", async () => {
  const { spawn, children } = fakeSpawner(handlers({ "thread/name/set": () => ({}), "thread/archive": () => ({}), "thread/unarchive": () => ({}) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  await engine.renameThread("t1", "New name", { cwd: "/work" });
  await engine.archiveThread("t1", { cwd: "/work" });
  await engine.unarchiveThread("t1", { cwd: "/work" });
  assert.deepEqual(children[0]!.requests("thread/name/set"), [{ threadId: "t1", name: "New name" }]);
  assert.deepEqual(children[0]!.requests("thread/archive"), [{ threadId: "t1" }]);
  assert.deepEqual(children[0]!.requests("thread/unarchive"), [{ threadId: "t1" }]);
  await engine.close();
});

test("rewind reverts the conversation before a turn and refuses to promise files", async () => {
  const { spawn, children } = fakeSpawner(handlers({ "thread/revert": () => ({ thread: threadRecord(THREAD), turnsBackwardsCursor: null, itemsBackwardsCursor: null }) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.resumeThread(THREAD, { cwd: "/work" });
  assert.deepEqual(await thread.rewind("turn-1"), { droppedTurns: 2 });
  assert.deepEqual(children[0]!.requests("thread/revert"), [{ threadId: THREAD, beforeTurnId: "turn-1" }]);
  await assert.rejects(thread.rewind("turn-1", { files: true }), UnsupportedFeatureError);
  await assert.rejects(thread.rewind("turn-9"), /No turn turn-9/u);
  await engine.close();
});

test("plan mode is a thread setting, an access level goes to turn/start, and both stick", async () => {
  const { spawn, children } = fakeSpawner(handlers({ "thread/settings/update": () => ({}) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work", access: "ask" });
  const server = children[0]!;
  const first = thread.run("Plan it", { mode: "plan", access: "auto" });
  await until(() => server.requests("turn/start").length === 1);
  const params = server.requests("turn/start")[0];
  assert.deepEqual(server.requests("thread/settings/update")[0], { threadId: THREAD, collaborationMode: { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: null, developer_instructions: null } } });
  assert.equal(params.collaborationMode, undefined, "Codex ignores a mode on turn/start");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.equal(params.sandboxPolicy.type, "workspaceWrite");
  complete(server, await first.id, "Here is the plan.");
  await first.result;
  const second = thread.run("Do it", { mode: "default" });
  await until(() => server.requests("turn/start").length === 2);
  const next = server.requests("turn/start")[1];
  assert.equal(server.requests("thread/settings/update")[1].collaborationMode.mode, "default");
  assert.equal(next.approvalsReviewer, "auto_review", "the access level set on the first turn sticks");
  complete(server, await second.id, "Done.");
  await second.result;
  await engine.close();
});

test("an output schema goes to turn/start and the reply comes back parsed", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const schema = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] };
  const thread = await engine.startThread({ cwd: "/work" });
  const turn = thread.run("Classify", { outputSchema: schema });
  const server = children[0]!;
  await until(() => server.requests("turn/start").length === 1);
  assert.deepEqual(server.requests("turn/start")[0].outputSchema, schema);
  complete(server, await turn.id, '{"tag":"answer"}');
  const result = await turn.result;
  assert.deepEqual(result.output, { tag: "answer" });
  const plain = thread.run("Chat");
  await until(() => server.requests("turn/start").length === 2);
  assert.equal(server.requests("turn/start")[1].outputSchema, undefined, "a schema is per turn");
  complete(server, await plain.id, '{"looks":"like json"}');
  assert.equal((await plain.result).output, undefined);
  await engine.close();
});

test("attached files are named by path, base64 ones saved first", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  const turn = thread.run({ text: "Read these", files: [{ type: "path", path: "/work/spec.pdf" }, { type: "base64", name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") }] });
  const server = children[0]!;
  await until(() => server.requests("turn/start").length === 1);
  const text: string = server.requests("turn/start")[0].input[0].text;
  assert.match(text, /^Read these\n\nAttached files:\n- \/work\/spec\.pdf\n- \S+notes\.txt$/u);
  const saved = text.split("\n").at(-1)!.slice(2);
  assert.equal(await readFile(saved, "utf8"), "hello");
  complete(server, await turn.id, "Read.");
  await turn.result;
  await engine.close();
});

test("goals are set, read and cleared, and their updates are events", async () => {
  const goal = { threadId: THREAD, objective: "Ship it", status: "active", tokenBudget: 5000, tokensUsed: 10, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 };
  const { spawn, children } = fakeSpawner(handlers({
    "thread/goal/set": () => ({ goal }),
    "thread/goal/get": () => ({ goal: { ...goal, status: "budgetLimited" } }),
    "thread/goal/clear": () => ({}),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  const events: AgentEvent[] = [];
  thread.subscribe((event) => events.push(event));
  assert.deepEqual(await thread.setGoal("Ship it", { tokenBudget: 5000 }), { objective: "Ship it", status: "active", tokenBudget: 5000, tokensUsed: 10, timeUsedSeconds: 3 });
  assert.equal(children[0]!.requests("thread/goal/set")[0].origin, "user");
  assert.equal((await thread.goal())?.status, "budget-limited");
  await thread.clearGoal();
  children[0]!.notify("thread/goal/updated", { threadId: THREAD, turnId: null, goal: { ...goal, status: "complete" } });
  children[0]!.notify("thread/goal/cleared", { threadId: THREAD });
  await until(() => events.filter((event) => event.type === "goal.updated").length === 2);
  const updates = events.filter((event) => event.type === "goal.updated") as Array<Extract<AgentEvent, { type: "goal.updated" }>>;
  assert.equal(updates[0]!.goal?.status, "complete");
  assert.equal(updates[1]!.goal, null);
  await engine.close();
});

test("review() runs Codex's review and its findings are the turn's text", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "review/start": (_params: any, server: FakeAppServer) => {
      queueMicrotask(() => {
        server.notify("turn/started", { threadId: THREAD, turn: { id: "review-1", items: [], status: "inProgress" } });
        server.notify("item/completed", { threadId: THREAD, turnId: "review-1", item: { type: "exitedReviewMode", id: "r", review: "One bug in a.ts:3." } });
        server.notify("turn/completed", { threadId: THREAD, turn: { id: "review-1", status: "completed", items: [], error: null } });
      });
      return { turn: { id: "review-1", items: [], status: "inProgress" }, reviewThreadId: THREAD };
    },
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  const result = await thread.review({ type: "base-branch", branch: "main" }).result;
  assert.equal(result.text, "One bug in a.ts:3.");
  assert.deepEqual(children[0]!.requests("review/start")[0], { threadId: THREAD, target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
  await engine.close();
});

test("shell, tasks and stopTask use the thread's shell and background terminals", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "thread/shellCommand": () => ({}),
    "thread/backgroundTerminals/list": () => ({ data: [{ itemId: "i", processId: "p1", command: "npm run dev", cwd: "/work", osPid: 9, cpuPercent: null, rssKb: null }], nextCursor: null }),
    "thread/backgroundTerminals/terminate": () => ({}),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  await thread.shell("git status", { timeoutMs: 5000 });
  assert.deepEqual(await thread.tasks(), [{ id: "p1", kind: "shell", description: "npm run dev", status: "running" }]);
  await thread.stopTask("p1");
  assert.deepEqual(children[0]!.requests("thread/shellCommand"), [{ threadId: THREAD, command: "git status", timeoutMs: 5000 }]);
  assert.deepEqual(children[0]!.requests("thread/backgroundTerminals/terminate"), [{ threadId: THREAD, processId: "p1" }]);
  await engine.close();
});

test("MCP controls: reload, OAuth sign-in and resources; live replacement is refused", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "config/mcpServer/reload": () => ({}),
    "mcpServer/oauth/login": () => ({ authorizationUrl: "https://auth.example/start" }),
    "mcpServer/resource/read": () => ({ contents: [{ uri: "notes://1", mimeType: "text/plain", text: "hi" }, { uri: "notes://2", blob: "AA==" }], originCallId: null }),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  await thread.reconnectMcp("notes");
  assert.deepEqual(await thread.mcpLogin("notes"), { url: "https://auth.example/start" });
  assert.deepEqual(await thread.readMcpResource("notes", "notes://1"), [{ uri: "notes://1", mimeType: "text/plain", text: "hi" }, { uri: "notes://2", blob: "AA==" }]);
  assert.equal(children[0]!.requests("config/mcpServer/reload").length, 1);
  await assert.rejects(thread.setMcpServers({}), UnsupportedFeatureError);
  await assert.rejects(thread.toggleMcp("notes", false), UnsupportedFeatureError);
  await engine.close();
});

test("an MCP server's startup status reaches every thread, even when Codex names none", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  const events: AgentEvent[] = [];
  thread.subscribe((event) => events.push(event));
  children[0]!.notify("mcpServer/startupStatus/updated", { threadId: null, name: "notes", status: "failed", error: "token expired", failureReason: "reauthenticationRequired" });
  await until(() => events.some((event) => event.type === "mcp.status"));
  assert.deepEqual(events.find((event) => event.type === "mcp.status"), {
    threadId: THREAD, turnId: "", type: "mcp.status", server: "notes", status: "failed", error: "token expired", needsLogin: true,
  });
  await engine.close();
});

test("hooks, warnings and renames become events", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  const events: AgentEvent[] = [];
  thread.subscribe((event) => events.push(event));
  const server = children[0]!;
  const run = { id: "h1", eventName: "preToolUse", sourcePath: "/hooks/check.sh", status: "blocked", statusMessage: "Not on main", entries: [] };
  server.notify("hook/started", { threadId: THREAD, turnId: null, run: { ...run, status: "running" } });
  server.notify("hook/completed", { threadId: THREAD, turnId: null, run });
  server.notify("warning", { threadId: THREAD, message: "Sandbox is off" });
  server.notify("thread/name/updated", { threadId: THREAD, threadName: "Fix tests" });
  await until(() => events.length >= 4);
  assert.deepEqual(events.map((event) => event.type), ["hook.started", "hook.completed", "notice", "thread.renamed"]);
  assert.deepEqual(events[1], { threadId: THREAD, turnId: "", type: "hook.completed", hookId: "h1", event: "preToolUse", name: "/hooks/check.sh", status: "blocked", output: "Not on main" });
  await engine.close();
});

test("engine events: account changes, config warnings and a finished sign-in", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "account/login/start": () => ({ type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.example/device", userCode: "ABCD-1234" }),
    "account/logout": () => ({}),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  const login = await engine.login({ method: "device-code" });
  assert.equal(login.url, "https://auth.example/device");
  assert.equal(login.code, "ABCD-1234");
  const server = children[0]!;
  server.notify("account/login/completed", { loginId: "login-1", success: true, error: null, onboardingEntrypoint: null });
  server.notify("account/updated", { authMode: "chatgpt", planType: "pro" });
  server.notify("configWarning", { summary: "Unknown key", details: "foo.bar" });
  assert.deepEqual(await login.done, { success: true });
  await until(() => events.length === 2);
  assert.deepEqual(events, [
    { type: "account.changed", provider: "codex", signedIn: true, plan: "pro" },
    { type: "notice", provider: "codex", kind: "config", message: "Unknown key", details: "foo.bar", raw: { summary: "Unknown key", details: "foo.bar" } },
  ]);
  await engine.logout();
  assert.equal(server.requests("account/logout").length, 1);
  await engine.close();
});

test("login() connects even when Codex is signed out", async () => {
  const { spawn } = fakeSpawner({
    "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
    "account/login/start": () => ({ type: "chatgpt", loginId: "l", authUrl: "https://auth.example/login" }),
  });
  const engine = new CodexEngine({ spawnProcess: spawn });
  assert.equal((await engine.login()).url, "https://auth.example/login");
  await assert.rejects(engine.models(), /not signed in/u);
  await engine.close();
});

test("searchFiles, config, plugins and skills use Codex's own calls", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    fuzzyFileSearch: () => ({ files: [
      { root: "/work", path: "src/b.ts", match_type: "file", file_name: "b.ts", score: 2, indices: [4] },
      { root: "/work", path: "src/a.ts", match_type: "file", file_name: "a.ts", score: 9, indices: null },
    ] }),
    "config/read": () => ({ config: { model: "gpt-6-luna" }, origins: {}, layers: [
      { name: { type: "project", dotCodexFolder: "/work/.codex" }, version: "1", config: { model: "gpt-6-luna" }, disabledReason: null },
      { name: { type: "user", file: "/home/.codex/config.toml", profile: null }, version: "1", config: { model: "gpt-6-sol" }, disabledReason: null },
    ] }),
    "plugin/list": () => ({ marketplaces: [{ name: "official", path: null, interface: null, plugins: [
      { id: "p1", name: "linear", version: "1.0", localVersion: null, installed: true, enabled: false, interface: { displayName: "Linear", shortDescription: "Issues" } },
    ] }], marketplaceLoadErrors: [], featuredPluginIds: [] }),
    "plugin/install": () => ({}),
    "plugin/uninstall": () => ({}),
    "skills/config/write": () => ({}),
    "skills/list": () => ({ data: [] }),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  assert.deepEqual(await engine.searchFiles("ts", { cwd: "/work" }), [{ path: "src/a.ts", score: 9 }, { path: "src/b.ts", score: 2, indices: [4] }]);
  const config = await engine.config({ cwd: "/work" });
  assert.deepEqual(config.values, { model: "gpt-6-luna" });
  assert.deepEqual(config.sources?.map((source) => source.name), ["user", "project"], "highest priority last");
  assert.deepEqual(await engine.plugins(), [{ id: "p1", name: "Linear", description: "Issues", installed: true, enabled: false, marketplace: "official", version: "1.0" }]);
  await engine.installPlugin({ name: "linear", marketplace: "official" });
  await engine.uninstallPlugin("p1");
  await engine.setSkillEnabled("deploy", false);
  const server = children[0]!;
  assert.deepEqual(server.requests("plugin/install"), [{ pluginName: "linear", remoteMarketplaceName: "official" }]);
  assert.deepEqual(server.requests("skills/config/write"), [{ name: "deploy", enabled: false }]);
  const thread = await engine.startThread({ cwd: "/work" });
  await thread.reloadSkills();
  assert.equal(server.requests("skills/list").at(-1).forceReload, true);
  await engine.close();
});

test("thread options: title, seed, agents and extra folders reach Codex", async () => {
  const { spawn, children } = fakeSpawner(handlers({ "thread/name/set": () => ({}), "thread/inject_items": () => ({}) }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  await engine.startThread({
    cwd: "/work",
    title: "Handoff",
    additionalDirectories: ["/data"],
    agents: { reviewer: { description: "Reviews diffs", prompt: "Review carefully.", model: "gpt-6-sol" } },
    seed: { provider: "claude", threadId: "s1", turns: [{ id: "1", status: "completed", entries: [{ kind: "message", role: "user", text: "Hi" }, { kind: "message", role: "assistant", text: "Hello" }] }] },
  });
  const server = children[0]!;
  const start = server.requests("thread/start")[0];
  assert.deepEqual(start.config.sandbox_workspace_write, { writable_roots: ["/data"] });
  const role = start.config.agents.reviewer;
  assert.equal(role.description, "Reviews diffs");
  assert.equal(await readFile(role.config_file, "utf8"), 'model = "gpt-6-sol"\ndeveloper_instructions = "Review carefully."\n');
  assert.deepEqual(server.requests("thread/name/set"), [{ threadId: THREAD, name: "Handoff" }]);
  assert.deepEqual(server.requests("thread/inject_items")[0].items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
  ]);
  await engine.close();
});

test("turn limits are refused rather than ignored", async () => {
  const engine = new CodexEngine({ spawnProcess: fakeSpawner(handlers()).spawn });
  await assert.rejects(engine.startThread({ cwd: "/work", limits: { maxTurns: 3 } }), UnsupportedFeatureError);
  await engine.close();
});

test("contextUsage() reads the last token report", async () => {
  const { spawn, children } = fakeSpawner(handlers());
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  assert.deepEqual(await thread.contextUsage(), { usedTokens: 0 });
  const breakdown = (total: number) => ({ totalTokens: total, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  children[0]!.notify("thread/tokenUsage/updated", { threadId: THREAD, turnId: "t", tokenUsage: { total: breakdown(90_000), last: breakdown(40_000), modelContextWindow: 200_000 } });
  await until(() => true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await thread.contextUsage(), { usedTokens: 40_000, maxTokens: 200_000, percent: 20 });
  await engine.close();
});

test("realtime sessions start, send and stop, and their output is events", async () => {
  const { spawn, children } = fakeSpawner(handlers({
    "thread/realtime/start": () => ({}),
    "thread/realtime/appendText": () => ({}),
    "thread/realtime/appendAudio": () => ({}),
    "thread/realtime/stop": () => ({}),
  }));
  const engine = new CodexEngine({ spawnProcess: spawn });
  const thread = await engine.startThread({ cwd: "/work" });
  const events: AgentEvent[] = [];
  thread.subscribe((event) => events.push(event));
  const session = await thread.realtime({ output: "audio", instructions: "Be brief." });
  await session.sendText("Hello");
  await session.sendAudio({ data: "AAAA", sampleRate: 24_000, channels: 1 });
  await session.stop();
  const server = children[0]!;
  assert.deepEqual(server.requests("thread/realtime/start")[0], { threadId: THREAD, outputModality: "audio", transport: { type: "websocket" }, prompt: "Be brief." });
  assert.deepEqual(server.requests("thread/realtime/appendAudio")[0].audio, { data: "AAAA", sampleRate: 24_000, numChannels: 1, samplesPerChannel: null, itemId: null });
  server.notify("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "Hi" });
  server.notify("thread/realtime/outputAudio/delta", { threadId: THREAD, audio: { data: "BBBB", sampleRate: 24_000, numChannels: 1, samplesPerChannel: null, itemId: null } });
  server.notify("thread/realtime/closed", { threadId: THREAD, reason: "stopped" });
  await until(() => events.length === 3);
  assert.deepEqual(events.map((event) => event.type), ["realtime.transcript.delta", "realtime.audio", "realtime.closed"]);
  await engine.close();
});

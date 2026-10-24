/**
 * @file Every engine keeps its word: each capability `capabilities()` reports
 * as missing makes its methods throw `UnsupportedFeatureError`, and each one it
 * reports as present does not. Runs against the fakes, so it checks the
 * engines' own claims, not the runtimes'.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpEngine } from "../src/acp/engine.ts";
import { ClaudeEngine } from "../src/claude/engine.ts";
import { CodexEngine } from "../src/codex/engine.ts";
import { UnsupportedFeatureError } from "../src/errors.ts";
import type { Capabilities, Engine, Thread, ThreadOptions } from "../src/types.ts";
import { fakeAcpSpawner } from "./fake-acp-agent.ts";
import { FakeAppServer, fakeSpawner } from "./fake-app-server.ts";
import { fakeClaudeSdk } from "./fake-claude-sdk.ts";

const CWD = "/tmp";

/** A Codex fake that answers every method with an empty result, plus what threads need to open. */
function codexEngine(): Engine {
  const known: Record<string, (params: any, server: FakeAppServer) => unknown> = {
    "thread/start": () => ({ thread: { id: "t" }, model: "gpt-6-luna" }),
    "thread/resume": (params: any) => ({ thread: { id: params.threadId }, model: "gpt-6-luna" }),
    "thread/fork": () => ({ thread: { id: "f" }, model: "gpt-6-luna" }),
    "account/read": () => ({ account: { type: "chatgpt", email: "someone@example.com", planType: "plus" }, requiresOpenaiAuth: true }),
    "initialize": () => ({ userAgent: "codex_cli_rs/0.164.0 (Mac OS 26.0; arm64)" }),
  };
  const handlers = new Proxy(known, { get: (target, method: string) => target[method] ?? (() => ({})) });
  return new CodexEngine({ spawnProcess: fakeSpawner(handlers).spawn });
}

function claudeEngine(): Engine {
  return new ClaudeEngine({ sdk: fakeClaudeSdk().sdk });
}

function acpEngine(): Engine {
  return new AcpEngine({ command: "fake-agent", args: ["acp"], cwd: CWD, spawnProcess: fakeAcpSpawner().spawn });
}

/** One way to reach a capability: what `capabilities()` says, and a call that uses it. */
interface Probe {
  name: string;
  claimed(capabilities: Capabilities): boolean;
  use(engine: Engine, thread: Thread): unknown;
}

const probes: Probe[] = [
  { name: "fork", claimed: (c) => c.fork, use: (engine) => engine.forkThread("t", { cwd: CWD }) },
  { name: "compact", claimed: (c) => c.compact, use: (_engine, thread) => thread.compact() },
  { name: "rewind", claimed: (c) => c.rewind, use: (_engine, thread) => thread.rewind("no-such-turn") },
  { name: "rewindFiles", claimed: (c) => c.rewindFiles, use: (_engine, thread) => thread.rewind("no-such-turn", { files: true }) },
  { name: "history: listThreads", claimed: (c) => c.history, use: (engine) => engine.listThreads() },
  { name: "history: readThread", claimed: (c) => c.history, use: (engine) => engine.readThread("t", { cwd: CWD }) },
  { name: "rename", claimed: (c) => c.rename, use: (_engine, thread) => thread.rename("x") },
  { name: "archive", claimed: (c) => c.archive, use: (engine) => engine.archiveThread("t", { cwd: CWD }) },
  { name: "structuredOutput", claimed: (c) => c.structuredOutput, use: (_engine, thread) => thread.run("x", { outputSchema: { type: "object" } }) },
  { name: "contextUsage", claimed: (c) => c.contextUsage, use: (_engine, thread) => thread.contextUsage() },
  { name: "goals", claimed: (c) => c.goals, use: (_engine, thread) => thread.goal() },
  { name: "review", claimed: (c) => c.review !== false, use: (_engine, thread) => thread.review({ type: "uncommitted" }) },
  { name: "shell", claimed: (c) => c.shell, use: (_engine, thread) => thread.shell("true") },
  { name: "listTasks", claimed: (c) => c.listTasks, use: (_engine, thread) => thread.tasks() },
  { name: "stopTask", claimed: (c) => c.stopTask, use: (_engine, thread) => thread.stopTask("x") },
  { name: "mcp.setServers", claimed: (c) => c.mcp.setServers, use: (_engine, thread) => thread.setMcpServers({}) },
  { name: "mcp.reconnect", claimed: (c) => c.mcp.reconnect, use: (_engine, thread) => thread.reconnectMcp("x") },
  { name: "mcp.toggle", claimed: (c) => c.mcp.toggle, use: (_engine, thread) => thread.toggleMcp("x", false) },
  { name: "mcp.login", claimed: (c) => c.mcp.login, use: (_engine, thread) => thread.mcpLogin("x") },
  { name: "mcp.readResource", claimed: (c) => c.mcp.readResource, use: (_engine, thread) => thread.readMcpResource("x", "x://1") },
  { name: "login", claimed: (c) => c.login, use: (engine) => engine.login() },
  { name: "logout", claimed: (c) => c.logout, use: (engine) => engine.logout() },
  { name: "limits", claimed: (c) => c.limits.length > 0, use: (engine) => engine.startThread({ cwd: CWD, limits: { maxTurns: 1 } }) },
  { name: "agents", claimed: (c) => c.agents, use: (engine) => engine.startThread({ cwd: CWD, agents: { helper: { description: "Helps", prompt: "Help." } } }) },
  { name: "skills.reload", claimed: (c) => c.skills.reload, use: (_engine, thread) => thread.reloadSkills() },
  { name: "skills.toggle", claimed: (c) => c.skills.toggle, use: (engine) => engine.setSkillEnabled("x", false) },
  { name: "plugins.list", claimed: (c) => c.plugins.list, use: (engine) => engine.plugins({ cwd: CWD }) },
  { name: "plugins.install", claimed: (c) => c.plugins.install, use: (engine) => engine.installPlugin({ name: "x" }) },
  { name: "plugins.reload", claimed: (c) => c.plugins.reload, use: (_engine, thread) => thread.reloadPlugins() },
  { name: "config", claimed: (c) => c.config, use: (engine) => engine.config({ cwd: CWD }) },
  { name: "realtime", claimed: (c) => c.realtime, use: (_engine, thread) => thread.realtime() },
];

/** Whether a call, sync or async, failed because the feature is unsupported. Other failures do not count. */
async function unsupported(call: () => unknown): Promise<boolean> {
  try {
    const value = call();
    // A Turn's result never rejects; it is enough that starting it did not throw.
    if (value && typeof value === "object" && "result" in value) return false;
    await value;
    return false;
  } catch (error) {
    return error instanceof UnsupportedFeatureError;
  }
}

for (const [provider, make, threadOptions] of [
  ["codex", codexEngine, {}],
  ["claude", claudeEngine, { fileCheckpoints: true }],
  ["acp", acpEngine, {}],
] as Array<[string, () => Engine, Partial<ThreadOptions>]>) {
  test(`${provider}: every capability it claims works, and every one it lacks is refused`, async () => {
    const engine = make();
    const capabilities = await engine.capabilities();
    assert.equal(capabilities.provider, provider);
    const wrong: string[] = [];
    for (const probe of probes) {
      // A fresh thread each time, so a turn one probe started cannot make the next fail for another reason.
      const thread = await engine.startThread({ cwd: CWD, ...threadOptions });
      const claimed = probe.claimed(capabilities);
      const refused = await unsupported(() => probe.use(engine, thread));
      if (claimed === refused) wrong.push(`${probe.name}: claimed ${claimed}, ${refused ? "refused" : "accepted"}`);
      await thread.close();
    }
    await engine.close();
    assert.deepEqual(wrong, []);
  });
}

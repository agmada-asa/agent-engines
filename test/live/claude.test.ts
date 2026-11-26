/** @file Live Claude smoke test on a cheap model. Runs only with `AGENT_ENGINES_LIVE=1`. */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeEngine } from "../../src/claude/engine.ts";
import { parityScenario } from "./parity.ts";
import { LIVE, smokeScenario } from "./scenario.ts";

const MODEL = process.env.AGENT_ENGINES_CLAUDE_MODEL ?? "haiku";

test("Claude: turn, steer, interrupt, compact, resume, delete", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 600_000 }, async (t) => {
  await smokeScenario(
    new ClaudeEngine(),
    {
      model: MODEL,
      effort: "low",
      // No operator settings, MCP servers or skills: just the built-in tools.
      mcpServers: {},
      claude: { settingSources: [], strictMcpConfig: true, skills: [] },
    },
    (line) => t.diagnostic(line),
  );
});

test("Claude: AskUserQuestion surfaces as a request even with full access", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 180_000 }, async (t) => {
  const engine = new ClaudeEngine();
  const cwd = await mkdtemp(join(tmpdir(), "agent-engines-live-claude-"));
  let threadId: string | undefined;
  try {
    const thread = await engine.startThread({
      cwd, model: MODEL, effort: "low", access: "full", mcpServers: {},
      claude: { settingSources: [], strictMcpConfig: true, skills: [] },
    });
    threadId = thread.id;
    let asked = false;
    const turn = thread.run("Use the AskUserQuestion tool to ask whether I prefer tea or coffee (options: Tea, Coffee). Then reply with my answer in one word.");
    for await (const event of turn) {
      if (event.type === "request" && event.request.kind === "question") {
        asked = true;
        await event.request.respond({ [event.request.questions[0].id]: ["Coffee"] });
      }
    }
    const result = await turn.result;
    t.diagnostic(`question turn: ${result.status} "${result.text}"`);
    assert.equal(asked, true);
    assert.match(result.text, /coffee/iu);
  } finally {
    if (threadId) await engine.deleteThread(threadId, { cwd }).catch(() => undefined);
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Claude: plan mode, structured output, history, rename, fork, rewind with files, handoff, review", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 900_000 }, async (t) => {
  await parityScenario(
    new ClaudeEngine(),
    { model: MODEL, effort: "low", mcpServers: {}, claude: { settingSources: [], strictMcpConfig: true, skills: [] } },
    (line) => t.diagnostic(line),
  );
});

test("Claude: a subagent's real model is confirmed from its own messages", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 180_000 }, async (t) => {
  const engine = new ClaudeEngine();
  const cwd = await mkdtemp(join(tmpdir(), "agent-engines-live-claude-"));
  let threadId: string | undefined;
  try {
    const thread = await engine.startThread({
      cwd, model: MODEL, effort: "low", access: "full", mcpServers: {},
      agents: { replier: { description: "Replies with one word.", prompt: "Reply with the single word: done.", model: "sonnet" } },
      claude: { settingSources: [], strictMcpConfig: true, skills: [] },
    });
    threadId = thread.id;
    const subagents = new Set<string>();
    const confirmed: { agentId?: string; model: string }[] = [];
    // Claude Code 2.1.332 can end the turn while the subagent still runs in the background,
    // so listen on the thread, across turns, until the subagent has ended.
    let ended!: () => void;
    const subagentEnded = new Promise<void>((resolve) => { ended = resolve; });
    const unsubscribe = thread.subscribe((event) => {
      if (event.type === "subagent.started") subagents.add(event.subagentId);
      if (event.type === "model.confirmed") confirmed.push({ agentId: event.agentId, model: event.model });
      if (event.type === "subagent.ended") ended();
    });
    for await (const _ of thread.run("Use the Agent tool with subagent_type \"replier\" and the prompt \"Go\". Then reply with its word.")) { /* events are read by subscribe */ }
    await Promise.race([subagentEnded, new Promise((resolve) => setTimeout(resolve, 120_000))]);
    unsubscribe();
    t.diagnostic(JSON.stringify(confirmed));
    assert.ok(subagents.size > 0, "the subagent started");
    assert.ok(confirmed.some((entry) => !entry.agentId && entry.model.includes("haiku")), "the main agent is confirmed on its own model");
    assert.ok(confirmed.some((entry) => entry.agentId && subagents.has(entry.agentId) && entry.model.includes("sonnet")), "the subagent is confirmed on sonnet, by its subagent ID");
  } finally {
    if (threadId) await engine.deleteThread(threadId, { cwd }).catch(() => undefined);
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Claude: a stdio MCP server delivered over stdin starts with its env", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 180_000 }, async (t) => {
  const engine = new ClaudeEngine();
  const cwd = await mkdtemp(join(tmpdir(), "agent-engines-live-claude-"));
  const token = `token-${Date.now()}`;
  let threadId: string | undefined;
  try {
    const thread = await engine.startThread({
      cwd, model: MODEL, effort: "low", access: "full",
      mcpServers: { envcheck: { command: process.execPath, args: [fileURLToPath(new URL("./env-mcp.mjs", import.meta.url))], env: { LIVE_MCP_TOKEN: token } } },
      claude: { settingSources: [], strictMcpConfig: true, skills: [] },
    });
    threadId = thread.id;
    let output: string | undefined;
    const turn = thread.run("Call the read_token tool from the envcheck MCP server, then reply with exactly what it returned.");
    for await (const event of turn) {
      if (event.type === "tool.completed" && event.tool.name === "mcp__envcheck__read_token") output = event.output;
    }
    const result = await turn.result;
    t.diagnostic(`mcp turn: ${result.status} tool output "${output}"`);
    assert.equal(result.status, "completed");
    assert.equal(output, token);
  } finally {
    if (threadId) await engine.deleteThread(threadId, { cwd }).catch(() => undefined);
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

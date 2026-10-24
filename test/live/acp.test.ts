/**
 * @file Live ACP test against OpenCode on one of its free models. Runs only
 * with `AGENT_ENGINES_LIVE=1`, and skips when `opencode` is not installed.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACP_AGENTS, AcpEngine } from "../../src/acp/engine.ts";
import type { AgentEvent } from "../../src/types.ts";
import { LIVE } from "./scenario.ts";

const MODEL = process.env.AGENT_ENGINES_ACP_MODEL ?? "opencode/big-pickle";

/** Whether `opencode` is on PATH. */
function installed(): Promise<boolean> {
  return new Promise((resolve) => execFile("opencode", ["--version"], (error) => resolve(!error)));
}

/** OpenCode does not offer session/delete over ACP; its CLI does. */
function deleteSession(id: string): Promise<void> {
  return new Promise((resolve) => execFile("opencode", ["session", "delete", id], () => resolve()));
}

test("ACP (OpenCode): turn with a tool and an edit, plan mode, resume with history, fork, handoff", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 600_000 }, async (t) => {
  if (!(await installed())) return t.skip("opencode is not installed");
  const engine = new AcpEngine(ACP_AGENTS.opencode);
  const cwd = await mkdtemp(join(tmpdir(), "agent-engines-live-acp-"));
  const created: string[] = [];
  try {
    const availability = await engine.availability();
    t.diagnostic(`availability: ${availability.message} ${availability.version ?? ""}`);
    assert.equal(availability.ready, true);
    const capabilities = await engine.capabilities();

    const thread = await engine.startThread({ cwd, model: MODEL, access: "full" });
    created.push(thread.id);
    const events: AgentEvent[] = [];
    const turn = thread.run(`Create a file named hello.txt in ${cwd} containing exactly the word hi, then reply with done.`);
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    const types = [...new Set(events.map((event) => event.type))].join(" ");
    t.diagnostic(`edit turn: ${result.status} "${result.text.slice(0, 60)}" [${types}]`);
    assert.equal(result.status, "completed");
    assert.equal((await readFile(join(cwd, "hello.txt"), "utf8")).trim(), "hi");
    assert.ok(events.some((event) => event.type === "tool.completed"), "no tool call was reported");

    if ((await engine.capabilities()).modes.includes("plan")) {
      const planned = await thread.run(`Create a file named second.txt in ${cwd}.`, { mode: "plan" }).result;
      t.diagnostic(`plan turn: ${planned.status} "${planned.text.slice(0, 80)}"`);
      assert.equal(await access(join(cwd, "second.txt")).then(() => true, () => false), false, "plan mode changed a file");
      await thread.run("Thanks.", { mode: "default" }).result;
    }

    const usage = await thread.contextUsage();
    t.diagnostic(`context: ${usage.usedTokens}/${usage.maxTokens ?? "?"}`);
    await thread.close();

    const resumed = await engine.resumeThread(thread.id, { cwd, model: MODEL, access: "full" });
    const history = await resumed.history();
    t.diagnostic(`history after resume: ${history.length} turns`);
    assert.ok(history.length >= 1, "loading the session replayed no history");
    const recall = await resumed.run("What is the name of the file you wrote the word hi into? Reply with just the name.").result;
    t.diagnostic(`resumed turn: "${recall.text.slice(0, 60)}"`);
    assert.match(recall.text, /hello\.txt/iu);

    if (capabilities.fork) {
      const fork = await engine.forkThread(thread.id, { cwd, model: MODEL });
      created.push(fork.id);
      t.diagnostic(`fork: ${fork.id}`);
      await fork.close();
    }
    if (capabilities.history) {
      const listed = await engine.listThreads({ cwd });
      t.diagnostic(`listed: ${listed.length}`);
      assert.ok(listed.some((summary) => summary.id === thread.id));
    }

    const seeded = await engine.startThread({ cwd, model: MODEL, seed: await resumed.export() });
    created.push(seeded.id);
    const carried = await seeded.run("Which file got the word hi written into it earlier? Reply with just the name.").result;
    t.diagnostic(`seeded turn: "${carried.text.slice(0, 60)}"`);
    assert.match(carried.text, /hello\.txt/iu);
  } finally {
    await engine.close();
    for (const id of created) await deleteSession(id);
    await rm(cwd, { recursive: true, force: true });
  }
});

/** @file Live Claude smoke test on a cheap model. Runs only with `AGENT_ENGINES_LIVE=1`. */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeEngine } from "../../src/claude/engine.ts";
import { LIVE, smokeScenario } from "./scenario.ts";

const MODEL = process.env.AGENT_ENGINES_CLAUDE_MODEL ?? "claude-haiku-5-5";

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
  try {
    const thread = await engine.startThread({
      cwd, model: MODEL, effort: "low", access: "full", mcpServers: {},
      claude: { settingSources: [], strictMcpConfig: true, skills: [] },
    });
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
    await engine.deleteThread(thread.id, { cwd });
  } finally {
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

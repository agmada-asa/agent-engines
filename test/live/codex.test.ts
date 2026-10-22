/** @file Live Codex smoke test on a cheap model. Runs only with `AGENT_ENGINES_LIVE=1`. */

import { test } from "node:test";
import { CodexEngine } from "../../src/codex/engine.ts";
import { readConfiguredMcpServerNames } from "../../src/presets.ts";
import { LIVE, smokeScenario } from "./scenario.ts";

const MODEL = process.env.AGENT_ENGINES_CODEX_MODEL ?? "gpt-6-luna";

test("Codex: turn, steer, interrupt, compact, resume, delete", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 600_000 }, async (t) => {
  // Switch off the operator's own MCP servers so the run starts none.
  const config: Record<string, unknown> = {};
  for (const name of await readConfiguredMcpServerNames()) {
    if (/^[A-Za-z0-9_-]+$/u.test(name)) config[`mcp_servers.${name}.enabled`] = false;
  }
  await smokeScenario(
    new CodexEngine({ launch: { config } }),
    { model: MODEL, effort: "low" },
    (line) => t.diagnostic(line),
  );
});

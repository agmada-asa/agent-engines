/** @file Live Codex smoke test on a cheap model. Runs only with `AGENT_ENGINES_LIVE=1`. */

import { test } from "node:test";
import { CodexEngine } from "../../src/codex/engine.ts";
import { readConfiguredMcpServerNames } from "../../src/presets.ts";
import { parityScenario } from "./parity.ts";
import { LIVE, smokeScenario } from "./scenario.ts";

const MODEL = process.env.AGENT_ENGINES_CODEX_MODEL ?? "gpt-6-luna";

/** Launch config that switches off the operator's own MCP servers, so a run starts none. */
async function quietConfig(): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};
  for (const name of await readConfiguredMcpServerNames()) {
    if (/^[A-Za-z0-9_-]+$/u.test(name)) config[`mcp_servers.${name}.enabled`] = false;
  }
  return config;
}

test("Codex: turn, steer, interrupt, compact, resume, delete", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 600_000 }, async (t) => {
  await smokeScenario(
    new CodexEngine({ launch: { config: await quietConfig() } }),
    { model: MODEL, effort: "low" },
    (line) => t.diagnostic(line),
  );
});

test("Codex: plan mode, structured output, history, rename, fork, rewind, handoff, review", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 900_000 }, async (t) => {
  await parityScenario(
    new CodexEngine({ launch: { config: await quietConfig() } }),
    { model: MODEL, effort: "low" },
    (line) => t.diagnostic(line),
  );
});

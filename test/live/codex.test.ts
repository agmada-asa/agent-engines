/** @file Live Codex smoke test on a cheap model. Runs only with `AGENT_ENGINES_LIVE=1`. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEngine } from "../../src/codex/engine.ts";
import { readConfiguredMcpServerNames } from "../../src/presets.ts";
import { parityScenario } from "./parity.ts";
import { LIVE, smokeScenario } from "./scenario.ts";

const MODEL = process.env.AGENT_ENGINES_CODEX_MODEL ?? "gpt-6-luna";

test("Codex: service tiers separate thread acknowledgment from turn requests", { skip: !LIVE && "set AGENT_ENGINES_LIVE=1", timeout: 90_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-engines-live-tiers-"));
  const engine = new CodexEngine({ launch: { config: await quietConfig() } });
  let threadId: string | undefined;
  try {
    const models = await engine.models();
    const model = models.find((entry) => entry.id === MODEL);
    assert.ok(model, "the requested test model must be in the live catalogue");
    assert.ok(Array.isArray(model.serviceTiers));
    const serviceTier = model.serviceTiers.some((tier) => tier.id === "priority") ? "priority" : null;
    const thread = await engine.startThread({ cwd, model: MODEL, effort: "low", serviceTier });
    threadId = thread.id;
    assert.equal(thread.serviceTier?.requested, serviceTier);
    assert.ok(Object.hasOwn(thread.serviceTier!, "accepted"), "the thread response must acknowledge its tier");
    t.diagnostic(`Requested ${JSON.stringify(serviceTier)}, thread accepted ${JSON.stringify(thread.serviceTier!.accepted)}`);
    const turn = thread.run("Reply with OK. Do not use tools.");
    const result = await turn.result;
    assert.equal(result.status, "completed", result.error?.message);
    assert.equal(result.serviceTier?.accepted, undefined, "thread settings are not turn confirmation");
    assert.deepEqual(result.serviceTier, { requested: serviceTier });
  } finally {
    if (threadId) await engine.deleteThread(threadId, { cwd }).catch(() => undefined);
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

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

/**
 * @file The live smoke scenario both providers run: a turn that is steered, a
 * turn that is interrupted, a resume that remembers the first turn, then a
 * compaction. Prompts are tiny so a run costs a few cheap turns. Opt-in only: the
 * tests skip unless `AGENT_ENGINES_LIVE=1`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Engine, ThreadOptions, Turn, TurnResult } from "../../src/types.ts";

export const LIVE = process.env.AGENT_ENGINES_LIVE === "1";

/** Runs a turn, calling `onEvent` for each event, and returns its events and result. */
async function drive(turn: Turn, onEvent: (event: AgentEvent) => void = () => undefined): Promise<{ events: AgentEvent[]; result: TurnResult }> {
  const events: AgentEvent[] = [];
  for await (const event of turn) {
    events.push(event);
    onEvent(event);
  }
  return { events, result: await turn.result };
}

/** One line per step, so a live run shows what happened. */
function summary(step: string, events: AgentEvent[], result: TurnResult): string {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const types = [...counts].map(([type, count]) => `${type}×${count}`).join(" ");
  return `${step}: ${result.status}${result.error ? ` (${result.error.kind}: ${result.error.message})` : ""} "${result.text.slice(0, 60)}" [${types}]`;
}

/** The scenario. `thread` holds provider-specific settings such as a cheap model. */
export async function smokeScenario(engine: Engine, thread: Omit<ThreadOptions, "cwd">, log: (line: string) => void): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `agent-engines-live-${engine.provider}-`));
  const options: ThreadOptions = { ...thread, cwd, access: "full" };
  let threadId: string | undefined;
  try {
    const availability = await engine.availability();
    log(`availability: ${availability.reason} ${availability.version ?? ""} ${availability.account?.plan ?? ""}`);
    assert.equal(availability.ready, true, availability.message);

    const first = await engine.startThread(options);
    threadId = first.id;
    log(`thread: ${first.id}`);

    // Steer: change the answer while the command runs.
    let steered = false;
    const steerTurn = first.run("Run the shell command `sleep 8; echo tick`, then reply with its output and nothing else.");
    const a = await drive(steerTurn, (event) => {
      if (!steered && !event.agentId && event.type === "tool.started") {
        steered = true;
        void steerTurn.steer("Change of plan: once the command has finished, reply with exactly the word BANANA and nothing else.")
          .then(() => log("steer: accepted"), (error: unknown) => log(`steer: rejected (${String(error)})`));
      }
    });
    log(summary("steered turn", a.events, a.result));
    assert.equal(steered, true, "the turn ran no tool, so there was nothing to steer during");
    assert.equal(a.result.status, "completed");
    assert.match(a.result.text, /banana/iu);

    // Interrupt: stop a long command as soon as it starts.
    const started = Date.now();
    const interruptTurn = first.run("Run the shell command `sleep 120`, then say done.");
    const b = await drive(interruptTurn, (event) => {
      if (!event.agentId && event.type === "tool.started") void interruptTurn.interrupt();
    });
    log(`${summary("interrupted turn", b.events, b.result)} in ${Math.round((Date.now() - started) / 1000)}s`);
    assert.equal(b.result.status, "interrupted");
    assert.ok(Date.now() - started < 90_000, "the interrupt did not stop the command");

    // Resume in a fresh thread object; history stays with the runtime.
    await first.close();
    const resumed = await engine.resumeThread(first.id, options);
    const last = await resumed.lastTurn();
    log(`last turn after resume: ${JSON.stringify(last)}`);
    assert.ok(last, "lastTurn found nothing after resume");
    const d = await drive(resumed.run("What single word did you reply with to my first request? Reply with just that word."));
    log(summary("resumed turn", d.events, d.result));
    assert.equal(d.result.status, "completed");
    assert.match(d.result.text, /banana/iu);

    // Compact, on the resumed thread. Asked after this, the model only has its summary to go on, so nothing is asked.
    const c = await drive(resumed.compact());
    log(summary("compact", c.events, c.result));
    assert.notEqual(c.result.status, "failed");
    assert.ok(c.events.some((event) => event.type === "compacted"), "no compacted event");

    await engine.deleteThread(first.id, { cwd });
    threadId = undefined;
    log("deleted thread");
  } finally {
    // A failed run still leaves nothing behind.
    if (threadId) await engine.deleteThread(threadId, { cwd }).catch(() => undefined);
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

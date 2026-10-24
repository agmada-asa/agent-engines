/**
 * @file The live scenario for thread history and control: plan mode, a
 * structured reply, context usage, history, rename, fork, rewind (with files
 * where the runtime can), a handoff seed and a review. Each step runs only where
 * `capabilities()` says it works, and checks that it does. Prompts are tiny.
 * Opt-in only: the tests skip unless `AGENT_ENGINES_LIVE=1`.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, ThreadOptions } from "../../src/types.ts";

/** Whether a file exists. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** The scenario. `thread` holds provider-specific settings such as a cheap model. */
export async function parityScenario(engine: Engine, thread: Omit<ThreadOptions, "cwd">, log: (line: string) => void): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `agent-engines-parity-${engine.provider}-`));
  const capabilities = await engine.capabilities();
  const options: ThreadOptions = { ...thread, cwd, access: "full", ...(capabilities.rewindFiles ? { fileCheckpoints: true } : {}) };
  const created: string[] = [];
  const file = join(cwd, "fruit.txt");
  try {
    const main = await engine.startThread({ ...options, ...(capabilities.rename ? { title: "Parity check" } : {}) });
    created.push(main.id);
    log(`thread: ${main.id}`);

    if (capabilities.modes.includes("plan")) {
      let proposed = false;
      const planTurn = main.run(`Create a file named fruit.txt in ${cwd} containing the word apple.`, { mode: "plan" });
      for await (const event of planTurn) {
        if (event.type === "plan.proposal.done") proposed = true;
        // Claude asks to leave plan mode; say not yet, so the turn ends with nothing changed.
        if (event.type === "request" && event.request.kind === "approval" && event.request.action === "plan") {
          await event.request.respond({ decision: "deny", message: "Not yet. Stop here; I will confirm later." });
        }
        // Codex's plan mode may ask questions first; leave them to its defaults.
        if (event.type === "request" && event.request.kind === "question") await event.request.respond({});
      }
      const planned = await planTurn.result;
      log(`plan turn: ${planned.status} proposed=${proposed} "${planned.text.slice(0, 80)}"`);
      assert.equal(planned.status, "completed");
      assert.equal(await exists(file), false, "plan mode changed a file");
    }
    const built = await main.run(`Create a file named fruit.txt in ${cwd} containing the word apple. Then reply with the code word KIWI.`, { mode: "default" }).result;
    log(`build turn: ${built.status} "${built.text.slice(0, 60)}"`);
    assert.equal(built.status, "completed");
    assert.equal(await exists(file), true, "the file was not created");

    if (capabilities.structuredOutput) {
      const schema = { type: "object", properties: { fruit: { type: "string" } }, required: ["fruit"], additionalProperties: false };
      const structured = await main.run("Which fruit is in fruit.txt? Answer in the required format.", { outputSchema: schema }).result;
      log(`structured turn: ${structured.status} ${JSON.stringify(structured.output)}`);
      assert.equal(structured.status, "completed");
      assert.match(String((structured.output as { fruit?: string } | undefined)?.fruit), /apple/iu);
    }

    if (capabilities.contextUsage) {
      const usage = await main.contextUsage();
      log(`context: ${usage.usedTokens}/${usage.maxTokens ?? "?"}`);
      assert.ok(usage.usedTokens > 0, "no context usage reported");
    }

    let turns = await main.history();
    log(`history: ${turns.length} turns`);
    if (capabilities.history) assert.ok(turns.length >= 2, "history is missing turns");

    if (capabilities.rename) {
      await main.rename("Parity check renamed");
      const listed = await engine.listThreads({ cwd, limit: 10 });
      log(`listed: ${listed.map((summary) => `${summary.id}=${summary.title ?? ""}`).join(", ")}`);
      assert.ok(listed.some((summary) => summary.id === main.id && /renamed/u.test(summary.title ?? "")), "the renamed thread is not listed with its title");
    }

    if (capabilities.fork && turns.length) {
      const fork = await engine.forkThread(main.id, { ...options, throughTurnId: turns[0]!.id });
      created.push(fork.id);
      const forkTurns = await fork.history();
      log(`fork: ${fork.id} with ${forkTurns.length} turns`);
      assert.equal(forkTurns.length, 1, "the fork kept more than the first turn");
      await fork.close();
    }

    if (capabilities.rewind) {
      turns = await main.history();
      // Go back to before the turn that created the file.
      const creating = turns.find((turn) => turn.entries.some((entry) => entry.kind === "message" && entry.role === "user" && /code word KIWI/u.test(entry.text)));
      assert.ok(creating, "could not find the turn that created the file");
      const rewound = await main.rewind(creating.id, { files: capabilities.rewindFiles });
      log(`rewind: dropped ${rewound.droppedTurns}, files ${JSON.stringify(rewound.files ?? null)}`);
      if (capabilities.rewindFiles) assert.equal(await exists(file), false, "rewind did not remove the file");
      const after = await main.run("If I gave you a code word earlier in this conversation, reply with it; otherwise reply NONE.").result;
      log(`after rewind: "${after.text.slice(0, 60)}"`);
      assert.doesNotMatch(after.text, /kiwi/iu, "the rewound turn is still in the conversation");
    }

    const exported = await main.export();
    const seeded = await engine.startThread({ ...options, seed: exported });
    created.push(seeded.id);
    const recall = await seeded.run("What is the name of the file I mentioned earlier? Reply with just the file name.").result;
    log(`seeded thread: "${recall.text.slice(0, 60)}"`);
    assert.match(recall.text, /fruit\.txt/iu);
    await seeded.close();

    if (capabilities.review) {
      const review = await main.review({ type: "custom", instructions: `Review ${file} for spelling mistakes. Keep it to one sentence.` }).result;
      log(`review: ${review.status} "${review.text.slice(0, 80)}"`);
      assert.equal(review.status, "completed");
      assert.ok(review.text.trim().length > 0, "the review said nothing");
    }
    await main.close();
  } finally {
    for (const id of created) await engine.deleteThread(id, { cwd }).catch(() => undefined);
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

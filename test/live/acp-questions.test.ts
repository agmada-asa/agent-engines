/**
 * @file Live check of ACP questions against Antigravity's ACP server, the agent
 * that asks them through `session/request_permission`. Runs only with
 * `AGENT_ENGINES_LIVE=1` and `AGENT_ENGINES_ANTIGRAVITY_COMMAND`, the path to a
 * signed-in `agy_acp_server.par`. It uses one session, in a temporary folder, and
 * small prompts; the session stays in Antigravity's history unless the server
 * offers to delete it. The model decides when to call its tools, so a failure can
 * mean the model did not ask.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AcpEngine } from "../../src/acp/engine.ts";
import type { Access, AgentEvent, ApprovalRequest, QuestionRequest, Thread } from "../../src/types.ts";
import { LIVE } from "./scenario.ts";

const COMMAND = process.env.AGENT_ENGINES_ANTIGRAVITY_COMMAND;
const skip = !LIVE ? "set AGENT_ENGINES_LIVE=1" : !COMMAND ? "set AGENT_ENGINES_ANTIGRAVITY_COMMAND" : false;

/** A prompt that makes the model ask one question with these options. */
function ask(question: string, options: string, then = "Then reply with only my answer."): string {
  return `Use your tool for asking the user a question to ask: ${question} Offer the options ${options}. ${then}`;
}

/** What a question gets back: a label by position, the caller's own words, or nothing. */
type Answer = { option: number } | { labels: number[] } | { words: string } | "decline";

interface Outcome {
  questions: QuestionRequest["questions"][number][];
  approvals: ApprovalRequest[];
  tools: AgentEvent[];
  status: string;
  text: string;
}

/** Runs one turn, answering questions in order and denying approvals. */
async function turn(thread: Thread, level: Access, text: string, answers: Answer[] = []): Promise<Outcome> {
  const running = thread.run(text, { access: level });
  const stop = setTimeout(() => void running.interrupt(), 180_000);
  const outcome: Omit<Outcome, "status" | "text"> = { questions: [], approvals: [], tools: [] };
  try {
    for await (const event of running) {
      if (event.type.startsWith("tool.")) outcome.tools.push(event);
      if (event.type !== "request") continue;
      if (event.request.kind === "approval") {
        outcome.approvals.push(event.request);
        await event.request.respond({ decision: "deny" });
        continue;
      }
      assert.equal(event.request.kind, "question");
      const request = event.request as QuestionRequest;
      const asked = request.questions[0]!;
      outcome.questions.push(asked);
      const answer = answers.shift() ?? "decline";
      const labels = asked.options.map((option) => option.label);
      if (answer === "decline") await request.respond({});
      else if ("option" in answer) await request.respond({ [asked.id]: [labels[answer.option]!] });
      else if ("labels" in answer) await request.respond({ [asked.id]: answer.labels.map((index) => labels[index]!) });
      else await request.respond({ [asked.id]: [answer.words] });
    }
  } finally {
    clearTimeout(stop);
  }
  const result = await running.result;
  return { ...outcome, status: result.status, text: result.text };
}

/** Whether a tool event in a turn is the placeholder for a question. */
function placeholders(outcome: Outcome): AgentEvent[] {
  return outcome.tools.filter((event) => "itemId" in event && String(event.itemId).startsWith("interaction_"));
}

test("Antigravity: questions at every access level and mode, free text, several questions, approvals", { skip, timeout: 1_800_000 }, async (t) => {
  const command = COMMAND!;
  const engine = new AcpEngine({ command, cwd: dirname(command) });
  const cwd = await mkdtemp(join(tmpdir(), "agent-engines-live-antigravity-"));
  let threadId: string | undefined;
  const log = (step: string, outcome: Outcome) => t.diagnostic(`${step}: ${outcome.status} questions=${outcome.questions.length} approvals=${outcome.approvals.length} tools=${outcome.tools.length} "${outcome.text.slice(0, 60)}"`);
  const setMode = async (modeId: string) => (await engine.connection()).request("session/set_mode", { sessionId: threadId, modeId });
  try {
    const availability = await engine.availability();
    t.diagnostic(`server: ${availability.version ?? "unknown"}`);
    assert.equal(availability.ready, true, availability.message);
    const thread = await engine.startThread({ cwd, access: "ask" });
    threadId = thread.id;

    for (const [level, question, options, pick, expected] of [
      ["ask", "A or B?", "A and B", 1, /\bB\b/u],
      ["full", "Yes or no?", "Yes and No", 1, /\bno\b/iu],
      ["accept-edits", "Left or right?", "Left and Right", 1, /right/iu],
      ["read-only", "Red, green or blue?", "Red, Green and Blue", 1, /green/iu],
    ] as const) {
      const outcome = await turn(thread, level, ask(question, options), [{ option: pick }]);
      log(`question at ${level}`, outcome);
      assert.equal(outcome.questions.length, 1, `${level} did not surface the question`);
      assert.equal(outcome.status, "completed");
      assert.match(outcome.text, expected);
      assert.deepEqual(placeholders(outcome), [], "the placeholder tool call was reported");
    }

    const worded = await turn(thread, "full", ask("Which metal?", "Tin and Lead", "Then reply with only my answer, whatever it is."), [{ words: "Zinc" }]);
    log("free text", worded);
    assert.equal(worded.questions[0]?.allowOther, true);
    assert.equal(worded.status, "completed");
    assert.match(worded.text, /zinc/iu);

    const several = await turn(thread, "ask", ask("Which fruits do you like? Let me pick more than one.", "Apple, Pear and Plum", "Then reply with only my answers."), [{ labels: [0, 2] }]);
    log("several labels", several);
    assert.equal(several.questions.length, 1);
    assert.equal(several.questions[0]?.multiSelect, true);
    assert.equal(several.status, "completed");
    assert.match(several.text, /apple/iu);
    assert.match(several.text, /plum/iu);

    const two = await turn(thread, "full", "Use your tool for asking the user questions to ask two questions in one call: Cat or dog? Offer the options Cat and Dog. Sun or moon? Offer the options Sun and Moon. Then reply with only my two answers.", [{ option: 1 }, { option: 1 }]);
    log("two questions", two);
    assert.equal(two.questions.length, 2, "the model did not ask both");
    assert.match(two.text, /dog/iu);
    assert.match(two.text, /moon/iu);
    for (const outcome of [worded, several, two]) assert.deepEqual(placeholders(outcome), []);

    const declined = await turn(thread, "full", ask("Tea or coffee?", "Tea and Coffee"), ["decline"]);
    log("declined", declined);
    assert.equal(declined.questions.length, 1);
    assert.equal(declined.status, "completed");
    assert.deepEqual(placeholders(declined), []);

    const denied = await turn(thread, "ask", "Run the shell command: echo one. Then reply with only its output.");
    log("command at ask", denied);
    assert.equal(denied.approvals.length, 1, "the command did not surface as an approval");
    const allowed = await turn(thread, "full", "Run the shell command: echo two. Then reply with only its output.");
    log("command at full", allowed);
    assert.equal(allowed.approvals.length, 0);
    assert.match(allowed.text, /two/u);
    const refused = await turn(thread, "read-only", "Run the shell command: echo three. Then reply with only its output.");
    log("command at read-only", refused);
    assert.equal(refused.approvals.length, 0);

    const edit = join(cwd, "edit.txt");
    const edited = await turn(thread, "accept-edits", `Create the file ${edit} containing the word hi, using your file tool and not a shell command. Then reply with done.`);
    log("edit at accept-edits", edited);
    assert.equal(edited.approvals.length, 0);
    await access(edit);
    const ran = await turn(thread, "accept-edits", "Run the shell command: echo four. Then reply with only its output.");
    log("command at accept-edits", ran);
    assert.equal(ran.approvals.length, 1, "accept-edits did not surface the command");

    // The server's own modes decide approvals before they reach the engine, so these run at `ask`.
    await setMode("yolo");
    const yoloQuestion = await turn(thread, "ask", ask("Up or down?", "Up and Down"), [{ option: 1 }]);
    log("question in yolo", yoloQuestion);
    assert.equal(yoloQuestion.questions.length, 1, "yolo answered the question itself");
    assert.match(yoloQuestion.text, /down/iu);
    const yoloCommand = await turn(thread, "ask", "Run the shell command: echo five. Then reply with only its output.");
    log("command in yolo", yoloCommand);
    assert.equal(yoloCommand.approvals.length, 0, "yolo still asked to run a command");
    assert.match(yoloCommand.text, /five/u);

    await setMode("auto_edit");
    const autoQuestion = await turn(thread, "ask", ask("Hot or cold?", "Hot and Cold"), [{ option: 1 }]);
    log("question in auto_edit", autoQuestion);
    assert.equal(autoQuestion.questions.length, 1, "auto_edit answered the question itself");
    assert.match(autoQuestion.text, /cold/iu);
    await setMode("default");

    await thread.close();
    const resumed = await engine.resumeThread(threadId, { cwd, access: "ask" });
    const replayed = (await resumed.history()).flatMap((entry) => entry.entries).filter((entry) => entry.kind === "tool");
    t.diagnostic(`replayed tool entries: ${replayed.map((entry) => (entry.kind === "tool" ? entry.tool.name : "")).join(" | ").slice(0, 400)}`);
    await resumed.close();
  } finally {
    if (threadId) {
      const deleted = await engine.deleteThread(threadId, { cwd }).then(() => true, () => false);
      t.diagnostic(deleted ? "deleted the session" : "the session stays in the agent's history");
    }
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

/**
 * @file Moving a conversation between runtimes. `Thread.export()` gives a
 * `PortableTranscript`; a new thread on any engine takes it as `seed`. Codex
 * adds it to the thread's history; the others put this rendering of it before
 * the first message.
 */

import type { PortableTranscript, TranscriptEntry } from "./types.ts";

/** Longest tool output kept per call in a rendering, so a seed stays a sensible size. */
const MAX_TOOL_OUTPUT = 2_000;

/** One entry as plain text, or undefined for entries a reader does not need. */
function renderEntry(entry: TranscriptEntry): string | undefined {
  switch (entry.kind) {
    case "message":
      return `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`;
    case "tool": {
      const input = typeof entry.tool.input === "string" ? entry.tool.input : JSON.stringify(entry.tool.input ?? {});
      const output = entry.output ? `\n${entry.output.length > MAX_TOOL_OUTPUT ? `${entry.output.slice(0, MAX_TOOL_OUTPUT)}…` : entry.output}` : "";
      return `[tool ${entry.tool.name}${entry.isError ? " failed" : ""}] ${input}${output}`;
    }
    case "files":
      return `[changed files] ${entry.changes.map((change) => `${change.kind} ${change.path}`).join(", ")}`;
    default:
      return undefined;
  }
}

/** A transcript as plain text, turn by turn. Reasoning is left out. */
export function renderTranscript(transcript: PortableTranscript): string {
  return transcript.turns
    .map((turn) => turn.entries.map(renderEntry).filter((line): line is string => line !== undefined).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

/** The context put before a seeded thread's first message on runtimes without history injection. */
export function seedPreamble(transcript: PortableTranscript): string {
  const text = renderTranscript(transcript);
  if (!text) return "";
  return [
    `This conversation continues one held with another agent (${transcript.provider}). Here it is so far:`,
    "<earlier-conversation>",
    text,
    "</earlier-conversation>",
    "",
    "Carry on from there. The next message is the user's.",
    "",
  ].join("\n");
}

/** A transcript as Responses API input items, for Codex `thread/inject_items`. */
export function responsesItems(transcript: PortableTranscript): unknown[] {
  const items: unknown[] = [];
  for (const turn of transcript.turns) {
    for (const entry of turn.entries) {
      if (entry.kind === "message") {
        items.push({ type: "message", role: entry.role, content: [{ type: entry.role === "user" ? "input_text" : "output_text", text: entry.text }] });
      } else {
        const text = renderEntry(entry);
        if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      }
    }
  }
  return items;
}

/**
 * @file Turns ACP `session/update` notifications into the neutral event
 * stream, and keeps the turns it saw as history (ACP has no call to read a
 * session back other than replaying it with `session/load`).
 *
 * Pure apart from its own bookkeeping, so it is unit-tested with recorded
 * update shapes and no process.
 */

import { unifiedDiff } from "../diff.ts";
import type { AgentEvent, CommandInfo, FileChange, HistoryTurn, NoticeKind, PlanStep, ToolCall, TranscriptEntry } from "../types.ts";

type Json = Record<string, any>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** The text of an ACP content block, if it has any. */
function blockText(block: unknown): string {
  const content = record(block);
  if (!content) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "resource") return String(record(content.resource)?.text ?? "");
  if (content.type === "resource_link") return String(content.uri ?? "");
  return "";
}

/** An ACP tool call as a neutral one. `execute` is a shell command; ACP does not mark MCP tools. */
export function acpTool(call: Json): ToolCall {
  const kind = String(call.kind ?? "other");
  const name = typeof call.name === "string" && call.name ? call.name : String(call.title ?? kind);
  return {
    kind: kind === "execute" ? "command" : kind === "fetch" && /search/iu.test(name) ? "web-search" : "builtin",
    name,
    input: call.rawInput ?? { title: call.title },
  };
}

/** A tool call's text output: its content blocks, else its raw output. */
function toolOutput(call: Json): string | undefined {
  const text = (Array.isArray(call.content) ? call.content : [])
    .map((item: Json) => (item?.type === "content" ? blockText(item.content) : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  const raw = call.rawOutput;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  const nested = record(raw)?.output;
  return typeof nested === "string" ? nested : JSON.stringify(raw);
}

/** The file edits a tool call carries, as unified diffs. */
function toolChanges(call: Json): FileChange[] {
  return (Array.isArray(call.content) ? call.content : [])
    .filter((item: Json) => item?.type === "diff" && typeof item.path === "string")
    .map((item: Json) => {
      const before = typeof item.oldText === "string" ? item.oldText : undefined;
      const diff = unifiedDiff(before ?? "", String(item.newText ?? ""));
      return { path: item.path, kind: before === undefined ? "add" : "update", ...(diff ? { diff } : {}) } satisfies FileChange;
    });
}

/** ACP plan entries as plan steps. */
function planSteps(entries: unknown): PlanStep[] {
  return (Array.isArray(entries) ? entries : []).map((entry: Json) => ({
    step: String(entry?.content ?? ""),
    status: entry?.status === "completed" ? "completed" : entry?.status === "in_progress" ? "in-progress" : "pending",
  }));
}

/** A notice's severity as a notice kind. */
function noticeKind(severity: unknown): NoticeKind {
  return severity === "warning" || severity === "error" ? "warning" : "info";
}

/** One session's updates as events, and the turns seen so far. */
export class AcpNormalizer {
  /** The turn updates belong to now; empty outside a turn. */
  turnId = "";
  /** Slash commands the agent offers, from its latest update. */
  commands: CommandInfo[] = [];
  /** The current mode ID, from the agent's latest update. */
  currentMode?: string;
  /** The session's config options (model, mode, effort…), latest first-class copy. */
  configOptions: Json[] = [];
  /** Tokens in the context and the window's size, from the latest usage update. */
  context?: { used: number; size: number };
  /** The session's title, from the latest info update. */
  title?: string;
  /** Turns seen, oldest first: replayed by `session/load`, then run on this handle. */
  readonly turns: HistoryTurn[] = [];
  private open?: { kind: "text" | "reasoning"; id: string; messageId?: string; text: string };
  private readonly tools = new Map<string, Json>();
  private readonly finished = new Set<string>();
  private counter = 0;
  private entries: TranscriptEntry[] = [];
  private replayTurn?: HistoryTurn;
  private lastAnswer = "";

  constructor(readonly threadId: string) {}

  /** The last agent message of the current turn. */
  get reply(): string {
    return this.lastAnswer;
  }

  /** Starts recording a live turn that begins with `prompt`. */
  startTurn(turnId: string, prompt: string): void {
    this.turnId = turnId;
    this.lastAnswer = "";
    this.entries = prompt ? [{ kind: "message", role: "user", text: prompt }] : [];
  }

  /** Closes the current turn: any open message ends, and the turn joins the history. */
  endTurn(status: HistoryTurn["status"]): AgentEvent[] {
    const events = this.closeOpen();
    // A tool call still running when the turn ends was cancelled with it.
    for (const [id, call] of this.tools) {
      const tool = acpTool(call);
      this.finished.add(id);
      events.push({ ...this.base(), type: "tool.completed", itemId: id, tool, output: "Cancelled when the turn ended.", isError: true });
      this.entries.push({ kind: "tool", tool, output: "Cancelled when the turn ended.", isError: true });
    }
    this.tools.clear();
    if (this.turnId) this.turns.push({ id: this.turnId, status, entries: this.entries });
    this.entries = [];
    this.turnId = "";
    return events;
  }

  /** Ends a `session/load` replay, keeping its last turn. */
  endReplay(): void {
    this.closeOpen();
    if (this.replayTurn) {
      this.replayTurn.entries.push(...this.entries);
      this.turns.push(this.replayTurn);
    }
    this.replayTurn = undefined;
    this.entries = [];
  }

  /** Maps one update. While `replaying`, it is recorded as history and no events come out. */
  normalize(update: Json, replaying = false): AgentEvent[] {
    const events = this.handle(update, replaying);
    return replaying ? [] : events;
  }

  private base(): { threadId: string; turnId: string } {
    return { threadId: this.threadId, turnId: this.turnId };
  }

  private handle(update: Json, replaying: boolean): AgentEvent[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (!replaying) return [];
        const text = blockText(update.content);
        // An agent reply still open belongs to the turn before this message.
        this.closeOpen();
        const last = this.entries[this.entries.length - 1];
        if (last?.kind === "message" && last.role === "user" && this.replayTurn) {
          last.text += text;
          return [];
        }
        // A user message after anything else starts the next replayed turn.
        if (this.replayTurn) {
          this.replayTurn.entries.push(...this.entries);
          this.turns.push(this.replayTurn);
        }
        this.replayTurn = { id: `${this.threadId}:${this.turns.length}`, status: "completed", entries: [] };
        this.entries = [{ kind: "message", role: "user", text }];
        return [];
      }
      case "agent_message_chunk":
        return this.chunk("text", update);
      case "agent_thought_chunk":
        return this.chunk("reasoning", update);
      case "tool_call":
      case "tool_call_update":
        return [...this.closeOpen(), ...this.toolCall(update)];
      case "plan":
        return [...this.closeOpen(), { ...this.base(), type: "plan.updated", steps: planSteps(update.entries) }];
      case "available_commands_update":
        this.commands = (Array.isArray(update.availableCommands) ? update.availableCommands : []).map((command: Json) => ({
          name: String(command.name),
          kind: "command" as const,
          ...(command.description ? { description: String(command.description) } : {}),
          ...(record(command.input)?.hint ? { argumentHint: String(command.input.hint) } : {}),
        }));
        return [];
      case "current_mode_update":
        this.currentMode = String(update.currentModeId ?? "");
        return [];
      case "config_option_update":
        this.configOptions = Array.isArray(update.configOptions) ? update.configOptions : [];
        return [];
      case "session_info_update":
        if (typeof update.title !== "string" || !update.title || update.title === this.title) return [];
        this.title = update.title;
        return [{ ...this.base(), type: "thread.renamed", title: update.title }];
      case "usage_update":
        if (typeof update.used === "number" && typeof update.size === "number") this.context = { used: update.used, size: update.size };
        return [];
      case "notice":
        return [{
          ...this.base(),
          type: "notice",
          kind: noticeKind(update.severity),
          message: String(update.title ?? ""),
          ...(typeof update.description === "string" && update.description ? { details: update.description } : {}),
          raw: update,
        }];
      case "compaction_update":
        if (update.status === "in_progress") return [{ ...this.base(), type: "status", status: { state: "compacting" } }];
        if (update.status === "completed") return [{ ...this.base(), type: "compacted" }];
        return [];
      default:
        return [];
    }
  }

  /** A streamed message or thought chunk; a new message ID, or a switch between the two, closes the open one. */
  private chunk(kind: "text" | "reasoning", update: Json): AgentEvent[] {
    const delta = blockText(update.content);
    const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
    const events: AgentEvent[] = [];
    if (this.open && (this.open.kind !== kind || (messageId && this.open.messageId && messageId !== this.open.messageId))) events.push(...this.closeOpen());
    if (!this.open) this.open = { kind, id: messageId ?? `${this.turnId || this.threadId}:${kind}:${this.counter++}`, ...(messageId ? { messageId } : {}), text: "" };
    this.open.text += delta;
    if (delta) events.push({ ...this.base(), type: kind === "text" ? "text.delta" : "reasoning.delta", itemId: this.open.id, delta });
    return events;
  }

  /** Ends the open message or thought, if there is one. */
  private closeOpen(): AgentEvent[] {
    const open = this.open;
    if (!open) return [];
    this.open = undefined;
    if (open.kind === "text") {
      if (open.text) {
        this.entries.push({ kind: "message", role: "assistant", text: open.text });
        this.lastAnswer = open.text;
      }
      return [{ ...this.base(), type: "text.done", itemId: open.id, text: open.text }];
    }
    if (open.text) this.entries.push({ kind: "reasoning", text: open.text });
    return [{ ...this.base(), type: "reasoning.done", itemId: open.id, text: open.text }];
  }

  /** A tool call starting or changing; patches merge into what is known of it. */
  private toolCall(update: Json): AgentEvent[] {
    const id = String(update.toolCallId);
    // A late patch to a call that has already finished changes nothing shown.
    if (this.finished.has(id)) return [];
    const known = this.tools.get(id);
    const merged: Json = { ...known };
    for (const [key, value] of Object.entries(update)) if (value !== undefined && value !== null) merged[key] = value;
    this.tools.set(id, merged);
    const events: AgentEvent[] = [];
    const tool = acpTool(merged);
    if (!known) events.push({ ...this.base(), type: "tool.started", itemId: id, tool });
    const status = merged.status;
    if ((status === "completed" || status === "failed") && !this.finished.has(id)) {
      this.finished.add(id);
      const output = toolOutput(merged);
      const isError = status === "failed";
      events.push({ ...this.base(), type: "tool.completed", itemId: id, tool, ...(output ? { output } : {}), isError });
      this.entries.push({ kind: "tool", tool, ...(output ? { output } : {}), ...(isError ? { isError } : {}) });
      const changes = isError ? [] : toolChanges(merged);
      if (changes.length) {
        events.push({ ...this.base(), type: "file.changed", itemId: id, changes });
        this.entries.push({ kind: "files", changes });
      }
      this.tools.delete(id);
    }
    return events;
  }
}

/**
 * @file Turns ACP `session/update` notifications into the neutral event
 * stream, and keeps the turns it saw as history (ACP has no call to read a
 * session back other than replaying it with `session/load`).
 *
 * Pure apart from its own bookkeeping, so it is unit-tested with recorded
 * update shapes and no process.
 */

import { unifiedDiff } from "../diff.ts";
import type { AgentEvent, CommandInfo, FileChange, HistoryTurn, NoticeKind, PlanStep, ThreadSetting, ToolCall, TranscriptEntry } from "../types.ts";

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

/** Whether a tool call's fields name no operation: no kind, input, name, locations or content. */
export function namesNoOperation(fields: Json): boolean {
  return fields.kind == null && [fields.rawInput, fields.name, fields.locations, fields.content].every(
    (value) => value == null || (typeof value === "object" && Object.keys(value).length === 0),
  );
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

/** ACP config options as neutral settings. Options of a type this client does not know are left out. */
export function acpSettings(options: readonly Json[]): ThreadSetting[] {
  return options.flatMap((option): ThreadSetting[] => {
    // The list comes from the agent: an entry that isn't an object is no setting.
    if (!record(option)) return [];
    const base = {
      id: String(option.id),
      name: String(option.name ?? option.id),
      ...(typeof option.description === "string" && option.description ? { description: option.description } : {}),
      ...(typeof option.category === "string" ? { category: option.category } : {}),
    };
    if (option.type === "boolean") return [{ ...base, type: "boolean", value: option.currentValue === true }];
    // A missing type is a select, as before ACP added toggles.
    if (option.type !== undefined && option.type !== "select") return [];
    const entries: Json[] = (Array.isArray(option.options) ? option.options : []).filter((entry: unknown) => record(entry));
    const values: Json[] = entries.flatMap((entry) => (Array.isArray(entry.options)
      ? entry.options.map((inner: Json) => ({ ...inner, group: String(entry.name ?? entry.group) }))
      : [entry]));
    return [{
      ...base,
      type: "select",
      value: String(option.currentValue ?? ""),
      options: values.map((entry) => ({
        value: String(entry.value),
        name: String(entry.name ?? entry.value),
        ...(entry.description ? { description: String(entry.description) } : {}),
        ...(entry.group ? { group: String(entry.group) } : {}),
      })),
    }];
  });
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
  private readonly started = new Set<string>();
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

  /** What the agent has announced of a tool call still in progress. */
  announcedTool(id: string): Json | undefined {
    return this.tools.get(id);
  }

  /**
   * A permission request settles what a call held back by `toolCall` is. A question
   * is no tool, so it and any later patch to it go unreported; anything else starts
   * now, ahead of its request. A call already reported stays reported.
   */
  permissionAsked(id: string, question: boolean): AgentEvent[] {
    if (this.started.has(id)) return [];
    if (question) {
      this.tools.delete(id);
      this.finished.add(id);
      return this.closeOpen();
    }
    const call = this.tools.get(id);
    if (!call) return [];
    this.started.add(id);
    return [{ ...this.base(), type: "tool.started", itemId: id, tool: acpTool(call) }];
  }

  /** Records a question and its answer in the turn, as the exchange they were. */
  questionAnswered(question: string, answer: string | undefined): void {
    this.entries.push({ kind: "message", role: "assistant", text: question });
    if (answer !== undefined) this.entries.push({ kind: "message", role: "user", text: answer });
  }

  /** Closes the current turn: any open message ends, and the turn joins the history. */
  endTurn(status: HistoryTurn["status"]): AgentEvent[] {
    const events = this.closeOpen();
    // A tool call still running when the turn ends was cancelled with it.
    for (const [id, call] of this.tools) {
      const tool = acpTool(call);
      this.finished.add(id);
      if (!this.started.has(id)) events.push({ ...this.base(), type: "tool.started", itemId: id, tool });
      events.push({ ...this.base(), type: "tool.completed", itemId: id, tool, output: "Cancelled when the turn ended.", isError: true });
      this.entries.push({ kind: "tool", tool, output: "Cancelled when the turn ended.", isError: true });
    }
    this.tools.clear();
    this.started.clear();
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
        // Entries that aren't objects are passed over rather than read: the list comes from the agent.
        this.commands = (Array.isArray(update.availableCommands) ? update.availableCommands : []).filter((command: unknown) => record(command)).map((command: Json) => ({
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
        return replaying ? [] : [{ ...this.base(), type: "settings.updated", settings: acpSettings(this.configOptions) }];
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
    const merged: Json = { ...this.tools.get(id) };
    for (const [key, value] of Object.entries(update)) if (value !== undefined && value !== null) merged[key] = value;
    this.tools.set(id, merged);
    const events: AgentEvent[] = [];
    const tool = acpTool(merged);
    const status = merged.status;
    // A pending call that names no operation may be the placeholder for a question,
    // so it is not reported until something shows it is a tool (see `permissionAsked`).
    const undecided = (status == null || status === "pending") && namesNoOperation(merged);
    if (!undecided && !this.started.has(id)) {
      this.started.add(id);
      events.push({ ...this.base(), type: "tool.started", itemId: id, tool });
    }
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
      this.started.delete(id);
    }
    return events;
  }
}

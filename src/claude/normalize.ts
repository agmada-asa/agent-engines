/**
 * @file Turns Claude Agent SDK messages into the neutral `AgentEvent` stream.
 * One normaliser per thread. Turn boundaries (a user message in, a `result` out)
 * are the engine's job; this maps everything in between.
 *
 * Subagents (the Agent/Task tool) are tracked by task ID: `task_started` and
 * `task_notification` mark their lifetime, and their own messages, which carry
 * `parent_tool_use_id` or `agent_id`, are tagged with that ID as `agentId`.
 */

import type { ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, FileChange, RateLimit, TokenUsage, ToolCall, TranscriptEntry, TurnError } from "../types.ts";

type Json = Record<string, any>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/**
 * Sums Claude's per-model usage. Input counts cache reads and writes, matching
 * Codex's input total. (From an earlier app's Claude engine.)
 */
export function claudeUsage(modelUsage: Readonly<Record<string, ModelUsage>> | undefined): TokenUsage | undefined {
  if (!modelUsage || !Object.keys(modelUsage).length) return undefined;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let contextWindow = 0;
  for (const usage of Object.values(modelUsage)) {
    inputTokens += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    cachedInputTokens += usage.cacheReadInputTokens;
    outputTokens += usage.outputTokens;
    reasoningOutputTokens += usage.thinkingTokens ?? 0;
    contextWindow = Math.max(contextWindow, usage.contextWindow ?? 0);
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/** A Claude subscription rate limit report in the neutral shape. */
export function claudeRateLimit(info: Json | undefined): RateLimit | undefined {
  if (!info) return undefined;
  const status = info.status === "rejected" ? "rejected" : info.status === "allowed_warning" ? "warning" : "ok";
  const utilization = typeof info.utilization === "number" ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : undefined;
  return {
    status,
    ...(typeof info.rateLimitType === "string" ? { window: info.rateLimitType } : {}),
    ...(utilization !== undefined ? { usedPercent: Math.round(utilization * 10) / 10 } : {}),
    ...(typeof info.resetsAt === "number" ? { resetsAt: new Date(info.resetsAt * 1000) } : {}),
  };
}

/** Built-in tools that write files; their results become `file.changed` events. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A Claude tool_use block as a neutral tool call. */
export function claudeTool(name: string, input: unknown): ToolCall {
  if (name.startsWith("mcp__")) {
    const [, server] = name.split("__");
    return { kind: "mcp", name, ...(server ? { server } : {}), input };
  }
  if (name === "Bash") return { kind: "command", name, input };
  if (name === "WebSearch") return { kind: "web-search", name, input };
  return { kind: "builtin", name, input };
}

/** Text of a tool_result block's content. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((block: Json) => (block?.type === "text" ? block.text : "")).filter(Boolean).join("\n");
  return text || undefined;
}

/**
 * Classifies a failed Claude turn from what the turn showed: the assistant
 * message error code, the last rate limit report and the result text.
 */
export function classifyClaudeError(message: string, assistantError: string | undefined, limit: RateLimit | undefined): TurnError {
  const text = message || "The Claude turn failed.";
  const resetsAt = limit?.status === "rejected" ? limit.resetsAt : undefined;
  if (limit?.status === "rejected" || /usage limit|hit your limit|limit reached|limit will reset|resets? (at|in)/iu.test(text)) {
    return { kind: "usage-limit", message: text, ...(resetsAt ? { resetsAt } : {}) };
  }
  if (assistantError === "rate_limit") return { kind: "usage-limit", message: text, ...(resetsAt ? { resetsAt } : {}) };
  if (assistantError === "overloaded" || /overloaded|529/u.test(text)) return { kind: "rate-limit", message: text };
  if (assistantError === "authentication_failed" || assistantError === "oauth_org_not_allowed" || assistantError === "billing_error" || /not logged in|please run \/login|invalid api key/iu.test(text)) {
    return { kind: "auth", message: text };
  }
  if (/prompt is too long|context window|context length/iu.test(text)) return { kind: "context-window", message: text };
  return { kind: "other", message: text };
}

/** SDK messages for one Claude session, as neutral events. */
export class ClaudeNormalizer {
  /** Last rate limit report, kept to date a usage-limit failure. */
  lastLimit?: RateLimit;
  /** Error code of the last assistant message that carried one, this turn. */
  assistantError?: string;
  private readonly tools = new Map<string, ToolCall>();
  private readonly taskByToolUse = new Map<string, string>();
  private readonly subagents = new Set<string>();
  private readonly endedSubagents = new Set<string>();
  /** message id → block index → item id, for streamed blocks. */
  private readonly streamBlocks = new Map<string, Map<number, string>>();
  /** message id → block type → count, so streamed and whole blocks get the same item IDs. */
  private readonly streamCounts = new Map<string, Map<string, number>>();
  private readonly wholeCounts = new Map<string, Map<string, number>>();
  private currentMessageId = new Map<string, string>();

  constructor(readonly threadId: string) {}

  /** Subagent task IDs seen so far. */
  get subagentIds(): string[] {
    return [...this.subagents];
  }

  /** Clears per-turn state. */
  startTurn(): void {
    this.assistantError = undefined;
  }

  /** Maps one SDK message to zero or more events for `turnId`. */
  normalize(message: SDKMessage, turnId: string): AgentEvent[] {
    const m = message as Json;
    const agentId = this.agentOf(m);
    const base = { threadId: this.threadId, turnId, ...(agentId ? { agentId } : {}) };

    switch (m.type) {
      case "stream_event":
        return this.streamEvent(record(m.event) ?? {}, base, agentId ?? "");
      case "assistant":
        return this.assistant(m, base);
      case "user":
        return this.user(m, base);
      case "rate_limit_event": {
        const limit = claudeRateLimit(record(m.rate_limit_info));
        if (!limit) return [];
        this.lastLimit = limit;
        return [{ threadId: this.threadId, turnId, type: "rate-limit", limit }];
      }
      case "system":
        return this.system(m, { threadId: this.threadId, turnId });
      default:
        return [];
    }
  }

  /** The subagent a message belongs to, if any. */
  private agentOf(m: Json): string | undefined {
    if (typeof m.agent_id === "string" && m.agent_id) return m.agent_id;
    const parent = m.parent_tool_use_id;
    if (typeof parent !== "string" || !parent) return undefined;
    return this.taskByToolUse.get(parent) ?? parent;
  }

  private streamEvent(event: Json, base: { threadId: string; turnId: string; agentId?: string }, stream: string): AgentEvent[] {
    if (event.type === "message_start") {
      const id = String(event.message?.id ?? "");
      this.currentMessageId.set(stream, id);
      return [];
    }
    const messageId = this.currentMessageId.get(stream) ?? "";
    if (event.type === "content_block_start") {
      const type = String(event.content_block?.type ?? "");
      if (type !== "text" && type !== "thinking") return [];
      const itemId = this.itemId(this.streamCounts, messageId, type);
      if (!this.streamBlocks.has(messageId)) this.streamBlocks.set(messageId, new Map());
      this.streamBlocks.get(messageId)!.set(Number(event.index), itemId);
      return [];
    }
    if (event.type === "content_block_delta") {
      const itemId = this.streamBlocks.get(messageId)?.get(Number(event.index));
      const delta = record(event.delta) ?? {};
      if (!itemId) return [];
      if (delta.type === "text_delta" && typeof delta.text === "string") return [{ ...base, type: "text.delta", itemId, delta: delta.text }];
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") return [{ ...base, type: "reasoning.delta", itemId, delta: delta.thinking }];
    }
    return [];
  }

  private assistant(m: Json, base: { threadId: string; turnId: string; agentId?: string }): AgentEvent[] {
    if (typeof m.error === "string") this.assistantError = m.error;
    const message = record(m.message) ?? {};
    const messageId = String(message.id ?? m.uuid ?? "");
    const events: AgentEvent[] = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "text" && typeof block.text === "string") {
        events.push({ ...base, type: "text.done", itemId: this.itemId(this.wholeCounts, messageId, "text"), text: block.text });
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        events.push({ ...base, type: "reasoning.done", itemId: this.itemId(this.wholeCounts, messageId, "thinking"), text: block.thinking });
      } else if (block?.type === "tool_use" || block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
        const name = block.type === "mcp_tool_use" ? `mcp__${block.server_name}__${block.name}` : String(block.name);
        const tool = claudeTool(name, block.input);
        this.tools.set(String(block.id), tool);
        events.push({ ...base, type: "tool.started", itemId: String(block.id), tool });
      }
    }
    return events;
  }

  private user(m: Json, base: { threadId: string; turnId: string; agentId?: string }): AgentEvent[] {
    const content = record(m.message)?.content;
    const events: AgentEvent[] = [];
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== "tool_result") continue;
      const id = String(block.tool_use_id);
      const tool = this.tools.get(id) ?? claudeTool("unknown", undefined);
      const output = resultText(block.content);
      const isError = block.is_error === true;
      events.push({ ...base, type: "tool.completed", itemId: id, tool, ...(output ? { output } : {}), isError });
      if (!isError && FILE_TOOLS.has(tool.name)) {
        const change = fileChange(tool, record(m.tool_use_result));
        if (change) events.push({ ...base, type: "file.changed", itemId: id, changes: [change] });
      }
      this.tools.delete(id);
    }
    return events;
  }

  private system(m: Json, base: { threadId: string; turnId: string }): AgentEvent[] {
    switch (m.subtype) {
      case "task_started": {
        // Shell and monitor tasks are tasks too; only agents are subagents.
        if (m.task_type && m.task_type !== "local_agent" && !m.subagent_type) return [];
        const id = String(m.task_id);
        if (typeof m.tool_use_id === "string") this.taskByToolUse.set(m.tool_use_id, id);
        if (this.subagents.has(id)) return [];
        this.subagents.add(id);
        return [{
          ...base,
          type: "subagent.started",
          subagentId: id,
          ...(typeof m.description === "string" ? { description: m.description } : {}),
          ...(typeof m.prompt === "string" ? { prompt: m.prompt } : {}),
        }];
      }
      case "task_notification": {
        const id = String(m.task_id);
        if (!this.subagents.has(id) || this.endedSubagents.has(id)) return [];
        this.endedSubagents.add(id);
        const status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
        return [{ ...base, type: "subagent.ended", subagentId: id, status, ...(typeof m.summary === "string" && m.summary ? { summary: m.summary } : {}) }];
      }
      case "compact_boundary": {
        const meta = record(m.compact_metadata) ?? {};
        return [{
          ...base,
          type: "compacted",
          ...(typeof meta.pre_tokens === "number" ? { beforeTokens: meta.pre_tokens } : {}),
          ...(typeof meta.post_tokens === "number" ? { afterTokens: meta.post_tokens } : {}),
        }];
      }
      case "model_refusal_fallback":
        return [{ ...base, type: "model.rerouted", from: String(m.original_model), to: String(m.fallback_model) }];
      default:
        return [];
    }
  }

  private itemId(counts: Map<string, Map<string, number>>, messageId: string, type: string): string {
    if (!counts.has(messageId)) counts.set(messageId, new Map());
    const byType = counts.get(messageId)!;
    const index = byType.get(type) ?? 0;
    byType.set(type, index + 1);
    return `${messageId}:${type}:${index}`;
  }
}

/** The file a successful Edit/Write call changed. */
function fileChange(tool: ToolCall, result: Json | undefined): FileChange | undefined {
  const input = record(tool.input) ?? {};
  const path = result?.filePath ?? input.file_path ?? input.notebook_path;
  if (typeof path !== "string") return undefined;
  const kind = result?.type === "create" ? "add" : "update";
  const patch = Array.isArray(result?.structuredPatch)
    ? result.structuredPatch.map((hunk: Json) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...(hunk.lines ?? [])].join("\n")).join("\n")
    : undefined;
  return { path, kind, ...(patch ? { diff: patch } : {}) };
}

/** Stored session messages (a subagent's transcript) as transcript entries. */
export function claudeTranscript(messages: ReadonlyArray<{ type: string; message: unknown }>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
  for (const entry of messages) {
    const content = record(entry.message)?.content;
    if (entry.type === "user") {
      if (typeof content === "string") {
        if (content.trim()) entries.push({ kind: "message", role: "user", text: content });
        continue;
      }
      const text = (Array.isArray(content) ? content : []).filter((block: Json) => block?.type === "text").map((block: Json) => block.text).join("\n");
      if (text.trim()) entries.push({ kind: "message", role: "user", text });
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== "tool_result") continue;
        const tool = tools.get(String(block.tool_use_id));
        if (!tool) continue;
        const output = resultText(block.content);
        if (output) tool.output = output;
        if (block.is_error === true) tool.isError = true;
      }
    } else if (entry.type === "assistant") {
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === "text" && block.text?.trim()) entries.push({ kind: "message", role: "assistant", text: block.text });
        else if (block?.type === "thinking" && block.thinking?.trim()) entries.push({ kind: "reasoning", text: block.thinking });
        else if (block?.type === "tool_use") {
          const tool: Extract<TranscriptEntry, { kind: "tool" }> = { kind: "tool", tool: claudeTool(String(block.name), block.input) };
          tools.set(String(block.id), tool);
          entries.push(tool);
        }
      }
    }
  }
  return entries;
}

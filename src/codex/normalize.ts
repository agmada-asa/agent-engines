/**
 * @file Turns Codex app-server notifications and server requests into the
 * neutral `AgentEvent` stream. One normaliser per thread; it also follows the
 * thread's collab subagents, which Codex runs as threads of their own, and tags
 * their events with `agentId` (the subagent's thread ID).
 *
 * Pure apart from its own bookkeeping, so it is unit-tested with recorded
 * notification shapes and no process.
 */

import type {
  AgentEvent,
  AgentRequest,
  FileChange,
  Goal,
  MessagePhase,
  PlanStep,
  RateLimit,
  RuntimeStatus,
  TokenUsage,
  ToolCall,
  TurnError,
} from "../types.ts";
import { wholeFileDiff } from "../diff.ts";

type Json = Record<string, any>;

/** Narrows an unknown value to a plain object. */
function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Codex's token breakdown in the neutral shape. */
export function codexUsage(tokenUsage: Json | undefined): TokenUsage | undefined {
  const total = record(tokenUsage?.total);
  if (!total) return undefined;
  return {
    inputTokens: Number(total.inputTokens ?? 0),
    cachedInputTokens: Number(total.cachedInputTokens ?? 0),
    outputTokens: Number(total.outputTokens ?? 0),
    reasoningOutputTokens: Number(total.reasoningOutputTokens ?? 0),
    totalTokens: Number(total.totalTokens ?? 0),
    ...(typeof tokenUsage?.modelContextWindow === "number" ? { contextWindow: tokenUsage.modelContextWindow } : {}),
  };
}

/** Rate limit windows from one Codex snapshot. A window is rejected once it is used up. */
export function codexRateLimits(snapshot: Json | undefined): RateLimit[] {
  if (!snapshot) return [];
  const reached = snapshot.rateLimitReachedType != null;
  const limits: RateLimit[] = [];
  for (const name of ["primary", "secondary"] as const) {
    const window = record(snapshot[name]);
    if (!window) continue;
    const usedPercent = typeof window.usedPercent === "number" ? window.usedPercent : undefined;
    limits.push({
      status: (usedPercent ?? 0) >= 100 || (reached && name === "primary" && usedPercent === undefined) ? "rejected" : "ok",
      window: typeof window.windowDurationMins === "number" ? `${name} (${window.windowDurationMins} min)` : name,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(typeof window.resetsAt === "number" ? { resetsAt: new Date(window.resetsAt * 1000) } : {}),
    });
  }
  return limits;
}

/** Name of a Codex error kind, whether sent as a string or a one-key object. */
function errorKind(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  const object = record(info);
  return object ? Object.keys(object)[0] : undefined;
}

/**
 * Classifies a Codex turn error. A usage limit takes its reset time from the
 * latest rate limit snapshot, since the error itself does not carry one.
 */
export function classifyCodexError(error: Json | undefined | null, limits: readonly RateLimit[] = []): TurnError {
  const message = typeof error?.message === "string" && error.message ? error.message : "The Codex turn failed.";
  const kind = errorKind(error?.codexErrorInfo);
  const resetsAt = limits.filter((limit) => limit.status === "rejected" && limit.resetsAt).map((limit) => limit.resetsAt!)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  switch (kind) {
    case "usageLimitExceeded":
    case "sessionBudgetExceeded":
      return { kind: "usage-limit", message, ...(resetsAt ? { resetsAt } : {}) };
    case "rateLimitExceeded":
      return { kind: "rate-limit", message, ...(resetsAt ? { resetsAt } : {}) };
    case "serverOverloaded":
      return { kind: "rate-limit", message };
    case "contextWindowExceeded":
      return { kind: "context-window", message };
    case "unauthorized":
      return { kind: "auth", message };
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return { kind: "connection", message };
    default:
      return { kind: "other", message };
  }
}

/** The text of an MCP tool result, joined. */
function mcpOutput(item: Json): string | undefined {
  if (item.error) return typeof item.error.message === "string" ? item.error.message : JSON.stringify(item.error);
  const content = item.result?.content;
  if (!Array.isArray(content)) return undefined;
  return content.map((block: Json) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n") || undefined;
}

/** The tool a Codex thread item represents, if it is one. */
export function codexTool(item: Json): ToolCall | undefined {
  switch (item.type) {
    case "commandExecution":
      return { kind: "command", name: "shell", input: { command: item.command, cwd: item.cwd } };
    case "mcpToolCall":
      return { kind: "mcp", name: `mcp__${item.server}__${item.tool}`, server: item.server, input: item.arguments };
    case "dynamicToolCall":
      return { kind: "host", name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, input: item.arguments };
    case "webSearch":
      return { kind: "web-search", name: "web_search", input: { query: item.query, action: item.action } };
    case "collabAgentToolCall":
      return { kind: "builtin", name: item.tool, input: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model } };
    case "imageView":
      return { kind: "builtin", name: "view_image", input: { path: item.path } };
    case "imageGeneration":
      return { kind: "builtin", name: "image_generation", input: {} };
    default:
      return undefined;
  }
}

/** Output and failure of a completed tool item. */
function toolOutcome(item: Json): { output?: string; isError: boolean } {
  switch (item.type) {
    case "commandExecution":
      return {
        ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}),
        isError: item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0),
      };
    case "mcpToolCall": {
      const output = mcpOutput(item);
      return { ...(output ? { output } : {}), isError: Boolean(item.error) || item.status === "failed" };
    }
    case "dynamicToolCall": {
      const text = Array.isArray(item.contentItems)
        ? item.contentItems.map((part: Json) => part?.text ?? "").filter(Boolean).join("\n")
        : "";
      return { ...(text ? { output: text } : {}), isError: item.success === false || item.status === "failed" };
    }
    default:
      return { isError: item.status === "failed" };
  }
}

/**
 * File changes from a `fileChange` item. Codex sends an update as unified hunks
 * but a new or deleted file as its whole text; both become hunks here.
 */
function fileChanges(item: Json): FileChange[] {
  const changes: FileChange[] = [];
  for (const change of Array.isArray(item.changes) ? item.changes : []) {
    // PatchChangeKind is { type: "add" | "delete" } or { type: "update", move_path }.
    const kindRecord = record(change?.kind);
    const kind = typeof change?.kind === "string" ? change.kind : (kindRecord?.type ?? "update");
    const text = typeof change?.diff === "string" ? change.diff : "";
    const diff = kind === "add" ? wholeFileDiff("+", text) : kind === "delete" ? wholeFileDiff("-", text) : text;
    const movedTo = kindRecord?.move_path;
    changes.push({
      path: String(change.path),
      kind: kind === "add" ? "add" : kind === "delete" ? "delete" : "update",
      ...(typeof movedTo === "string" && movedTo ? { movedTo } : {}),
      ...(diff ? { diff } : {}),
    });
  }
  return changes;
}

/** Codex's message phase in the neutral shape; partial and final answers are both the answer. */
function messagePhase(phase: unknown): MessagePhase | undefined {
  if (phase === "commentary") return "commentary";
  if (phase === "final_answer" || phase === "partial_answer") return "answer";
  return undefined;
}

/** Codex plan steps in the neutral shape. */
function planSteps(plan: unknown): PlanStep[] {
  return (Array.isArray(plan) ? plan : []).map((entry: Json) => ({
    step: String(entry?.step ?? ""),
    status: entry?.status === "completed" ? "completed" : entry?.status === "inProgress" ? "in-progress" : "pending",
  }));
}

/** A Codex thread status as a runtime status; undefined for states with no neutral meaning (not loaded, system error). */
function threadStatus(status: Json | undefined): RuntimeStatus | undefined {
  if (status?.type === "idle") return { state: "idle" };
  if (status?.type !== "active") return undefined;
  const waitingOn: Array<"approval" | "input"> = [];
  for (const flag of Array.isArray(status.activeFlags) ? status.activeFlags : []) {
    if (flag === "waitingOnApproval") waitingOn.push("approval");
    else if (flag === "waitingOnUserInput") waitingOn.push("input");
  }
  return waitingOn.length ? { state: "waiting", waitingOn } : { state: "working" };
}

/** A Codex goal in the neutral shape. */
export function codexGoal(goal: Json | undefined): Goal | undefined {
  if (!goal || typeof goal.objective !== "string") return undefined;
  const status: Goal["status"] =
    goal.status === "usageLimited" ? "usage-limited"
    : goal.status === "budgetLimited" ? "budget-limited"
    : goal.status === "paused" || goal.status === "blocked" || goal.status === "complete" ? goal.status
    : "active";
  return {
    objective: goal.objective,
    status,
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {}),
    ...(typeof goal.tokensUsed === "number" ? { tokensUsed: goal.tokensUsed } : {}),
    ...(typeof goal.timeUsedSeconds === "number" ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
  };
}

/** A finished hook run's status in the neutral shape. */
function hookStatus(status: unknown): "completed" | "failed" | "blocked" | "stopped" {
  return status === "failed" || status === "blocked" || status === "stopped" ? status : "completed";
}

/** The text a hook run printed, joined. */
function hookOutput(run: Json): string | undefined {
  const text = (Array.isArray(run.entries) ? run.entries : []).map((entry: Json) => (typeof entry?.text === "string" ? entry.text : "")).filter(Boolean).join("\n");
  return text || (typeof run.statusMessage === "string" && run.statusMessage ? run.statusMessage : undefined);
}

/** A realtime audio chunk in the neutral shape. */
function audioChunk(audio: Json | undefined): { data: string; sampleRate: number; channels: number } {
  return { data: String(audio?.data ?? ""), sampleRate: Number(audio?.sampleRate ?? 24_000), channels: Number(audio?.numChannels ?? 1) };
}

/** Most items of each kind remembered from `item/started` (agent message phases, proposed file changes). */
const MAX_REMEMBERED_ITEMS = 256;

/** Adds to a bounded map, forgetting the oldest entry once it is full. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= MAX_REMEMBERED_ITEMS && !map.has(key)) map.delete(map.keys().next().value!);
  map.set(key, value);
}

const ENDED_AGENT = new Set(["completed", "errored", "shutdown", "interrupted", "notFound"]);

/** Notifications for one thread and its subagents, as neutral events. */
export class CodexNormalizer {
  /** Latest rate limit windows, kept to date a usage-limit failure. */
  limits: RateLimit[] = [];
  /** The turn currently running on the main thread. */
  currentTurnId = "";
  private readonly subagents = new Set<string>();
  private readonly endedSubagents = new Set<string>();
  private readonly turnText = new Map<string, string>();
  private readonly turnErrors = new Map<string, Json>();
  private readonly phases = new Map<string, MessagePhase>();
  private readonly proposed = new Map<string, FileChange[]>();
  private latestUsage?: TokenUsage;
  /** Tokens in the context after the last model call, and the window's size. */
  context?: { usedTokens: number; maxTokens?: number };

  constructor(readonly threadId: string) {}

  /** Subagent thread IDs seen so far, so the engine can route and delete them. */
  get subagentIds(): string[] {
    return [...this.subagents];
  }

  /** The changes a `fileChange` item announced when it started, for the approval that follows. */
  proposedChanges(itemId: unknown): FileChange[] | undefined {
    return typeof itemId === "string" ? this.proposed.get(itemId) : undefined;
  }

  /** Whether a notification for `threadId` belongs to this thread. */
  owns(threadId: unknown): boolean {
    return threadId === this.threadId || (typeof threadId === "string" && this.subagents.has(threadId));
  }

  /** Maps one notification to zero or more events. */
  normalize(method: string, params: unknown): AgentEvent[] {
    const p = record(params) ?? {};
    // Account-wide notifications carry no thread.
    if (method === "account/rateLimits/updated") {
      this.limits = codexRateLimits(record(p.rateLimits));
      return this.limits.map((limit) => this.event({ type: "rate-limit", limit }));
    }
    // An MCP server the app-server started for every thread.
    if (method === "mcpServer/startupStatus/updated" && (p.threadId === null || p.threadId === undefined)) return [this.mcpStatus(p)];
    if (!this.owns(p.threadId)) return [];
    const agentId = p.threadId === this.threadId ? undefined : (p.threadId as string);
    const base = (turnId?: unknown) => ({
      threadId: this.threadId,
      turnId: agentId ? this.currentTurnId : typeof turnId === "string" ? turnId : this.currentTurnId,
      ...(agentId ? { agentId } : {}),
    });

    switch (method) {
      case "turn/started": {
        if (agentId) return [];
        const turnId = String(record(p.turn)?.id ?? "");
        this.currentTurnId = turnId;
        return [{ ...base(turnId), type: "turn.started" }];
      }
      case "item/agentMessage/delta": {
        const phase = this.phases.get(String(p.itemId));
        return [{ ...base(p.turnId), type: "text.delta", itemId: String(p.itemId), delta: String(p.delta ?? ""), ...(phase ? { phase } : {}) }];
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return [{ ...base(p.turnId), type: "reasoning.delta", itemId: String(p.itemId), delta: String(p.delta ?? "") }];
      case "item/commandExecution/outputDelta":
        return [{ ...base(p.turnId), type: "tool.output.delta", itemId: String(p.itemId), delta: String(p.delta ?? "") }];
      case "item/mcpToolCall/progress":
        return [{ ...base(p.turnId), type: "tool.progress", itemId: String(p.itemId), ...(typeof p.message === "string" ? { message: p.message } : {}) }];
      case "item/plan/delta":
        return [{ ...base(p.turnId), type: "plan.proposal.delta", itemId: String(p.itemId), delta: String(p.delta ?? "") }];
      case "item/fileChange/patchUpdated":
        // The patch grew while streaming; keep the approval's proposed changes current.
        remember(this.proposed, String(p.itemId), fileChanges(p));
        return [];
      case "turn/plan/updated":
        return [{
          ...base(p.turnId),
          type: "plan.updated",
          steps: planSteps(p.plan),
          ...(typeof p.explanation === "string" && p.explanation ? { explanation: p.explanation } : {}),
        }];
      case "turn/diff/updated":
        return [{ ...base(p.turnId), type: "diff.updated", diff: String(p.diff ?? "") }];
      case "thread/status/changed": {
        const status = threadStatus(record(p.status));
        return status ? [{ ...base(), type: "status", status }] : [];
      }
      case "item/started":
        return this.itemStarted(record(p.item) ?? {}, base(p.turnId));
      case "item/completed":
        return this.itemCompleted(record(p.item) ?? {}, base(p.turnId), agentId);
      case "thread/tokenUsage/updated": {
        if (agentId) return [];
        const usage = codexUsage(record(p.tokenUsage));
        if (!usage) return [];
        this.latestUsage = usage;
        const last = record(record(p.tokenUsage)?.last);
        if (last) {
          const window = record(p.tokenUsage)?.modelContextWindow;
          this.context = { usedTokens: Number(last.totalTokens ?? 0), ...(typeof window === "number" ? { maxTokens: window } : {}) };
        }
        return [{ ...base(p.turnId), type: "usage", usage }];
      }
      case "model/rerouted":
        return [{ ...base(p.turnId), type: "model.rerouted", from: String(p.fromModel), to: String(p.toModel) }];
      case "serverRequest/resolved":
        return [{ ...base(), type: "request.resolved", requestId: String(p.requestId) }];
      case "error": {
        // A retried error is not the turn's outcome; the final one arrives with turn/completed.
        if (p.willRetry === true) {
          const message = record(p.error)?.message;
          return [{ ...base(p.turnId), type: "status", status: { state: "retrying", ...(typeof message === "string" && message ? { retry: { message } } : {}) } }];
        }
        if (!agentId && typeof p.turnId === "string") this.turnErrors.set(p.turnId, record(p.error) ?? {});
        return [];
      }
      case "turn/completed":
        return agentId ? [] : this.turnCompleted(record(p.turn) ?? {});
      case "hook/started": {
        const run = record(p.run) ?? {};
        return [{ ...base(p.turnId), type: "hook.started", hookId: String(run.id), event: String(run.eventName ?? ""), ...(typeof run.sourcePath === "string" ? { name: run.sourcePath } : {}) }];
      }
      case "hook/completed": {
        const run = record(p.run) ?? {};
        const output = hookOutput(run);
        return [{
          ...base(p.turnId),
          type: "hook.completed",
          hookId: String(run.id),
          event: String(run.eventName ?? ""),
          ...(typeof run.sourcePath === "string" ? { name: run.sourcePath } : {}),
          status: hookStatus(run.status),
          ...(output ? { output } : {}),
        }];
      }
      case "thread/goal/updated": {
        if (agentId) return [];
        const goal = codexGoal(record(p.goal));
        return goal ? [{ ...base(p.turnId), type: "goal.updated", goal }] : [];
      }
      case "thread/goal/cleared":
        return agentId ? [] : [{ ...base(), type: "goal.updated", goal: null }];
      case "mcpServer/startupStatus/updated":
        return [{ ...this.mcpStatus(p), ...(agentId ? { agentId } : {}) } as AgentEvent];
      case "thread/name/updated":
        return agentId || typeof p.threadName !== "string" ? [] : [{ ...base(), type: "thread.renamed", title: p.threadName }];
      case "warning":
      case "guardianWarning":
        return typeof p.message === "string" ? [{ ...base(), type: "notice", kind: "warning", message: p.message, raw: params }] : [];
      case "model/verification":
        return [{ ...base(p.turnId), type: "notice", kind: "moderation", message: `Model verification: ${(Array.isArray(p.verifications) ? p.verifications : []).join(", ")}`, raw: params }];
      case "thread/realtime/started":
        return [{ ...base(), type: "realtime.started", ...(typeof p.realtimeSessionId === "string" ? { sessionId: p.realtimeSessionId } : {}) }];
      case "thread/realtime/transcript/delta":
        return [{ ...base(), type: "realtime.transcript.delta", role: String(p.role ?? ""), delta: String(p.delta ?? "") }];
      case "thread/realtime/transcript/done":
        return [{ ...base(), type: "realtime.transcript.done", role: String(p.role ?? ""), text: String(p.text ?? "") }];
      case "thread/realtime/outputAudio/delta":
        return [{ ...base(), type: "realtime.audio", audio: audioChunk(record(p.audio)) }];
      case "thread/realtime/error":
        return [{ ...base(), type: "realtime.error", message: String(p.message ?? "") }];
      case "thread/realtime/closed":
        return [{ ...base(), type: "realtime.closed", ...(typeof p.reason === "string" && p.reason ? { reason: p.reason } : {}) }];
      default:
        return [];
    }
  }

  private mcpStatus(p: Json): AgentEvent {
    return {
      threadId: this.threadId,
      turnId: this.currentTurnId,
      type: "mcp.status",
      server: String(p.name ?? ""),
      status: String(p.status ?? "unknown"),
      ...(typeof p.error === "string" && p.error ? { error: p.error } : {}),
      ...(p.failureReason === "reauthenticationRequired" ? { needsLogin: true } : {}),
    };
  }

  private itemStarted(item: Json, base: { threadId: string; turnId: string; agentId?: string }): AgentEvent[] {
    if (item.type === "subAgentActivity" && item.kind === "started") return this.subagentStarted(base, String(item.agentThreadId), { model: item.model });
    if (item.type === "agentMessage") {
      const phase = messagePhase(item.phase);
      if (phase) remember(this.phases, String(item.id), phase);
      return [];
    }
    if (item.type === "fileChange") {
      remember(this.proposed, String(item.id), fileChanges(item));
      return [];
    }
    if (item.type === "contextCompaction") return [{ ...base, type: "status", status: { state: "compacting" } }];
    const tool = codexTool(item);
    return tool ? [{ ...base, type: "tool.started", itemId: String(item.id), tool }] : [];
  }

  private itemCompleted(item: Json, base: { threadId: string; turnId: string; agentId?: string }, agentId?: string): AgentEvent[] {
    const itemId = String(item.id);
    switch (item.type) {
      case "agentMessage": {
        const text = String(item.text ?? "");
        const phase = messagePhase(item.phase) ?? this.phases.get(itemId);
        this.phases.delete(itemId);
        // A progress note is not the turn's reply, even when it is the last message so far.
        if (!agentId && text && phase !== "commentary") this.turnText.set(base.turnId, text);
        return [{ ...base, type: "text.done", itemId, text, ...(phase ? { phase } : {}) }];
      }
      case "reasoning": {
        const parts: string[] = [...(item.content ?? []), ...(item.content?.length ? [] : item.summary ?? [])];
        return [{ ...base, type: "reasoning.done", itemId, text: parts.join("\n\n") }];
      }
      case "fileChange":
        this.proposed.delete(itemId);
        return item.status === "completed" ? [{ ...base, type: "file.changed", itemId, changes: fileChanges(item) }] : [];
      case "contextCompaction":
        return [{ ...base, type: "compacted" }];
      case "plan":
        return [{ ...base, type: "plan.proposal.done", itemId, text: String(item.text ?? "") }];
      case "exitedReviewMode": {
        // A review's findings are its turn's reply.
        const text = String(item.review ?? "");
        if (!agentId && text) this.turnText.set(base.turnId, text);
        return text ? [{ ...base, type: "text.done", itemId, text, phase: "answer" }] : [];
      }
      case "subAgentActivity":
        if (item.kind === "completed" || item.kind === "interrupted") {
          return this.subagentEnded(base, String(item.agentThreadId), item.kind === "completed" ? "completed" : "stopped");
        }
        return [];
    }
    const tool = codexTool(item);
    if (!tool) return [];
    const events: AgentEvent[] = [{ ...base, type: "tool.completed", itemId, tool, ...toolOutcome(item) }];
    if (item.type === "collabAgentToolCall") {
      if (item.tool === "spawnAgent") {
        for (const id of item.receiverThreadIds ?? []) events.push(...this.subagentStarted(base, String(id), { prompt: item.prompt, model: item.model }));
      }
      for (const [id, state] of Object.entries(record(item.agentsStates) ?? {})) {
        const status = record(state)?.status;
        if (ENDED_AGENT.has(status)) {
          events.push(...this.subagentEnded(base, id, status === "completed" ? "completed" : status === "errored" ? "failed" : "stopped", record(state)?.message));
        }
      }
    }
    return events;
  }

  private subagentStarted(base: { threadId: string; turnId: string }, id: string, details: { prompt?: unknown; model?: unknown }): AgentEvent[] {
    if (!id || this.subagents.has(id)) return [];
    this.subagents.add(id);
    return [{
      threadId: base.threadId,
      turnId: base.turnId,
      type: "subagent.started",
      subagentId: id,
      ...(typeof details.prompt === "string" ? { prompt: details.prompt } : {}),
      ...(typeof details.model === "string" ? { model: details.model } : {}),
    }];
  }

  private subagentEnded(base: { threadId: string; turnId: string }, id: string, status: "completed" | "failed" | "stopped", summary?: unknown): AgentEvent[] {
    if (!id || this.endedSubagents.has(id)) return [];
    this.subagents.add(id);
    this.endedSubagents.add(id);
    return [{
      threadId: base.threadId,
      turnId: base.turnId,
      type: "subagent.ended",
      subagentId: id,
      status,
      ...(typeof summary === "string" && summary ? { summary } : {}),
    }];
  }

  private turnCompleted(turn: Json): AgentEvent[] {
    const turnId = String(turn.id ?? this.currentTurnId);
    const base = { threadId: this.threadId, turnId };
    const text = this.turnText.get(turnId) ?? lastAgentMessage(turn) ?? "";
    const usage = this.latestUsage;
    this.turnText.delete(turnId);
    const error = record(turn.error) ?? this.turnErrors.get(turnId);
    this.turnErrors.delete(turnId);
    if (this.currentTurnId === turnId) this.currentTurnId = "";
    if (turn.status === "failed") {
      return [{ ...base, type: "turn.failed", error: classifyCodexError(error, this.limits), ...(usage ? { usage } : {}) }];
    }
    return [{ ...base, type: "turn.completed", status: turn.status === "interrupted" ? "interrupted" : "completed", text, ...(usage ? { usage } : {}) }];
  }

  private event<T extends Omit<AgentEvent, "threadId" | "turnId">>(body: T): AgentEvent {
    return { threadId: this.threadId, turnId: this.currentTurnId, ...body } as unknown as AgentEvent;
  }
}

/** The final agent message of a turn payload that is not a progress note, if it has one. */
function lastAgentMessage(turn: Json): string | undefined {
  const items: Json[] = Array.isArray(turn.items) ? turn.items : [];
  for (const item of [...items].reverse()) {
    if (item?.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string" && item.text.trim()) return item.text;
  }
  return undefined;
}

/** A neutral request plus the native answer it resolves to. */
export interface PendingCodexRequest {
  request: AgentRequest;
  /** Settles with the JSON-RPC result to send back. */
  response: Promise<unknown>;
  /** Answers with the safe refusal, for a turn or thread that ended first. */
  cancel(): void;
}

const COMMAND_DECISIONS = { allow: "accept", "allow-session": "acceptForSession", deny: "decline", cancel: "cancel" } as const;
const LEGACY_DECISIONS = { allow: "approved", "allow-session": "approved_for_session", deny: "denied", cancel: "abort" } as const;

/**
 * Wraps one Codex server request as a neutral `AgentRequest`. Returns undefined
 * for methods that are not questions or approvals (host tool calls and the rest).
 * `context.proposedChanges` are the changes the approved item announced when it
 * started; a file-change approval carries them, since its own params do not.
 */
export function codexRequest(
  id: number | string,
  method: string,
  params: unknown,
  context: { proposedChanges?: FileChange[] } = {},
): PendingCodexRequest | undefined {
  const p = record(params) ?? {};
  let settle!: (value: unknown) => void;
  const response = new Promise<unknown>((resolve) => (settle = resolve));
  let answered = false;
  const answer = async (value: unknown) => {
    if (answered) return;
    answered = true;
    settle(value);
  };
  const requestId = String(id);

  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const command = method === "item/commandExecution/requestApproval";
    const request: AgentRequest = {
      kind: "approval",
      id: requestId,
      action: command ? "command" : "file-change",
      title: command ? `Run ${p.command ?? "a command"}` : "Change files",
      ...(typeof p.command === "string" ? { command: p.command } : {}),
      ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      ...(!command && context.proposedChanges ? { changes: context.proposedChanges } : {}),
      raw: params,
      respond: ({ decision }) => answer({ decision: COMMAND_DECISIONS[decision] }),
    };
    return { request, response, cancel: () => void answer({ decision: "cancel" }) };
  }

  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    const command = method === "execCommandApproval";
    const request: AgentRequest = {
      kind: "approval",
      id: requestId,
      action: command ? "command" : "file-change",
      title: command ? `Run ${Array.isArray(p.command) ? p.command.join(" ") : "a command"}` : "Change files",
      ...(Array.isArray(p.command) ? { command: p.command.join(" ") } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      raw: params,
      respond: ({ decision }) => answer({ decision: LEGACY_DECISIONS[decision] }),
    };
    return { request, response, cancel: () => void answer({ decision: "abort" }) };
  }

  if (method === "item/permissions/requestApproval") {
    const request: AgentRequest = {
      kind: "approval",
      id: requestId,
      action: "permissions",
      title: "Widen permissions",
      input: p.permissions,
      ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      raw: params,
      respond: ({ decision }) =>
        answer(decision === "allow" || decision === "allow-session"
          ? { permissions: grantedPermissions(p.permissions), scope: decision === "allow" ? "turn" : "session" }
          : { permissions: {}, scope: "turn" }),
    };
    return { request, response, cancel: () => void answer({ permissions: {}, scope: "turn" }) };
  }

  if (method === "item/tool/requestUserInput") {
    const request: AgentRequest = {
      kind: "question",
      id: requestId,
      questions: (Array.isArray(p.questions) ? p.questions : []).map((question: Json) => ({
        id: String(question.id),
        header: String(question.header ?? ""),
        question: String(question.question ?? ""),
        options: (question.options ?? []).map((option: Json) => ({ label: String(option.label), description: String(option.description ?? "") })),
        multiSelect: false,
        allowOther: question.isOther === true,
        secret: question.isSecret === true,
      })),
      raw: params,
      respond: (answers) =>
        answer({ answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) }),
    };
    return { request, response, cancel: () => void answer({ answers: {} }) };
  }

  if (method === "mcpServer/elicitation/request") {
    const mode = p.mode === "url" ? "url" : "form";
    const request: AgentRequest = {
      kind: "elicitation",
      id: requestId,
      server: String(p.serverName ?? ""),
      message: String(p.message ?? p.description ?? p.title ?? ""),
      mode,
      ...(typeof p.url === "string" ? { url: p.url } : {}),
      ...(p.requestedSchema !== undefined ? { schema: p.requestedSchema } : {}),
      raw: params,
      respond: ({ action, content }) => answer({ action, content: content ?? null, _meta: null }),
    };
    return { request, response, cancel: () => void answer({ action: "cancel", content: null, _meta: null }) };
  }

  return undefined;
}

/** Grants exactly what was requested, dropping nulls the response type does not allow. */
function grantedPermissions(requested: unknown): Json {
  const granted: Json = {};
  for (const [key, value] of Object.entries(record(requested) ?? {})) if (value != null) granted[key] = value;
  return granted;
}

/**
 * @file The provider-neutral surface: engines, threads, turns and the one event
 * stream both runtimes are normalised into.
 *
 * Nothing here decides policy. Which tools run, who approves what and how long a
 * turn may take are the consumer's choices, passed in as options; the engines
 * only translate them into each runtime's native settings.
 */

/** The runtimes this library drives. */
export type ProviderId = "codex" | "claude";

/** One runtime: its catalogue, sign-in and threads. Create with `createEngine`. */
export interface Engine {
  readonly provider: ProviderId;
  /** Whether the runtime is installed, recent enough and signed in on a subscription. Never throws. */
  availability(): Promise<Availability>;
  /** The models and efforts the signed-in runtime offers right now. */
  models(): Promise<ModelInfo[]>;
  /** Starts a new thread. Its ID is known straight away and can be saved to resume it later. */
  startThread(options: ThreadOptions): Promise<Thread>;
  /** Reopens a saved thread in the same `cwd`; history stays with the runtime. */
  resumeThread(threadId: string, options: ThreadOptions): Promise<Thread>;
  /**
   * Deletes what this Mac keeps of a thread: the runtime's session files and,
   * for subagents this engine saw, theirs too. Safe on a thread already gone.
   */
  deleteThread(threadId: string, options: { cwd: string }): Promise<void>;
  /** Stops every thread and the runtime process. Safe to call more than once. */
  close(): Promise<void>;
}

/** Result of `Engine.availability()`; `ready` means a turn can start. */
export interface Availability {
  provider: ProviderId;
  ready: boolean;
  /** Why it is not ready, in a form a settings screen can branch on. */
  reason: "ready" | "missing-executable" | "unsupported-version" | "signed-out" | "api-key" | "probe-failed";
  /** One plain sentence for the user. */
  message: string;
  /** Serving runtime version, when it started. */
  version?: string;
  /** Account, when signed in: plan type and email only, never credentials. */
  account?: { kind: "subscription" | "api-key" | "other"; plan?: string; email?: string };
}

/** One model offered by a runtime's own catalogue. */
export interface ModelInfo {
  /** Value to pass as `model`. */
  id: string;
  label: string;
  description?: string;
  /** Efforts this model accepts; empty when the runtime has no effort setting for it. */
  efforts: string[];
  defaultEffort?: string;
  /** Whether `fastMode` can be used with this model. */
  fastMode: boolean;
  isDefault: boolean;
  /** The full model ID an alias such as `haiku` points to right now (Claude). */
  resolvedModel?: string;
  /** Hidden from the runtime's own picker (Codex), but still usable. */
  hidden?: boolean;
  inputModalities?: string[];
}

/**
 * An MCP server given to one thread. `sdk` is an in-process server made with the
 * Claude Agent SDK's `createSdkMcpServer`, passed as is; Claude only (Codex
 * answers host tools through `codex.dynamicTools` instead).
 *
 * `alwaysLoad` (Claude) puts every tool of the server in the prompt instead of
 * deferring it behind tool search, which matters when tool search is not an
 * allowed tool. Codex ignores it.
 */
export type McpServer =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; alwaysLoad?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }
  | { type: "sdk"; name: string; instance: unknown };

/** One MCP server as a thread sees it. */
export interface McpServerState {
  name: string;
  /** Runtime's own status word: `connected`, `failed`, `pending`, `disabled`… */
  status: string;
  tools: string[];
}

/**
 * How much a thread may do without asking.
 *
 * - `full`: everything runs without approval and outside any sandbox.
 * - `ask`: the runtime's defaults, with anything needing approval surfaced as a `request` event.
 * - `read-only`: no writes; anything that would need approval is refused.
 *
 * Provider options (`codex.approvalPolicy`, `claude.permissionMode`…) override this.
 */
export type Access = "full" | "ask" | "read-only";

/** Settings for a thread, used on start and again on resume. */
export interface ThreadOptions {
  /** Absolute working directory. A resumed thread must use the one it started in. */
  cwd: string;
  model?: string;
  effort?: string;
  /** Codex `fast` service tier, or Claude fast mode. */
  fastMode?: boolean;
  access?: Access;
  /** Extra instructions: Codex developer instructions, appended to Claude's system prompt. */
  instructions?: string;
  mcpServers?: Record<string, McpServer>;
  /** Extra environment for the agent's tools (Claude); Codex takes env on the engine. */
  env?: Record<string, string>;
  /** Fails a turn that the runtime silently moves to another model. Defaults to true. */
  strictModel?: boolean;
  /** Codex-only settings, passed through. */
  codex?: CodexThreadOptions;
  /** Claude-only settings, passed through to the SDK's `query` options. */
  claude?: ClaudeThreadOptions;
}

/** Codex thread settings that have no neutral equivalent. */
export interface CodexThreadOptions {
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Network inside the workspace-write and read-only sandboxes. When set, every
   * turn also sends the matching sandbox policy and the thread's approval policy,
   * so they are reasserted turn by turn.
   */
  networkAccess?: boolean;
  /** Config overrides for this thread, as `codex --config` keys (`web_search`, `features.x`…). */
  config?: Record<string, unknown>;
  /** Tools the host answers itself, through `CodexEngineOptions.onToolCall`. */
  dynamicTools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** Not written to disk; cannot be resumed. */
  ephemeral?: boolean;
  /**
   * Who answers approval requests. Set `user` to keep them coming to the host
   * even when the operator's config routes them to Codex's own reviewer.
   */
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent";
  /** Replaces Codex's base instructions entirely. */
  baseInstructions?: string;
}

/**
 * Claude thread settings. Anything the SDK's `query` options accept can be
 * passed in `extra`; the named fields are the ones consumers usually set.
 */
export interface ClaudeThreadOptions {
  /** Which settings files load. Omitted loads all, as the CLI does; `[]` loads none. */
  settingSources?: Array<"user" | "project" | "local">;
  /** Built-in tools available. Omitted keeps Claude Code's defaults; `[]` turns them all off. */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  /** Ignore MCP servers from settings and plugins; only `mcpServers` load. */
  strictMcpConfig?: boolean;
  /** Skills to load, `"all"`, or `[]` for none. */
  skills?: string[] | "all";
  /** Replaces the system prompt instead of appending `instructions` to Claude Code's own. */
  systemPrompt?: string;
  /** Claude Code executable; defaults to the binary the SDK bundles. */
  executable?: string;
  /** Forward subagents' text and thinking, not only their tool calls. Defaults to true. */
  forwardSubagentText?: boolean;
  /** Any other SDK `query` option, merged last. */
  extra?: Record<string, unknown>;
}

/** What a user sends: text, and optionally images. */
export type TurnInput = string | { text: string; images?: ImageInput[] };

/** An image sent with a turn. */
export type ImageInput =
  | { type: "path"; path: string }
  | { type: "base64"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string };

/** Per-turn changes; they also stick for later turns, as both runtimes do. */
export interface TurnOptions {
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

/** A conversation with one runtime. */
export interface Thread {
  readonly id: string;
  readonly provider: ProviderId;
  /** Starts a turn. Fails with `SteerRejectedError` semantics only via `Turn.steer`; one turn runs at a time. */
  run(input: TurnInput, options?: TurnOptions): Turn;
  /** Compacts the thread's context. Runs as a turn of its own, ending with a `compacted` event. */
  compact(): Turn;
  /** The running turn, if any, including one the agent started itself. */
  readonly activeTurn: Turn | undefined;
  /**
   * Every event on this thread, across turns. This is how a consumer sees a turn
   * the agent started on its own (Claude does when a background subagent finishes).
   * Returns an unsubscribe function.
   */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** A subagent's transcript so far, by the `agentId` its events carried. */
  subagentTranscript(agentId: string): Promise<TranscriptEntry[]>;
  /**
   * How the thread's last turn ended, read back from the runtime: for picking up
   * after a restart. Codex records the status. Claude's transcript does not, so
   * a turn this object did not run reports `unknown` with its last reply.
   * Undefined before the first turn.
   */
  lastTurn(): Promise<LastTurn | undefined>;
  /**
   * Asks the runtime to stop a turn by ID, including one this object did not
   * start: after a restart, `lastTurn()` can report a Codex turn still `running`.
   * Claude stops its active turn when the ID matches; a turn from an earlier
   * process cannot still be running, so anything else is a no-op.
   */
  interruptTurn(turnId: string): Promise<void>;
  /** The MCP servers this thread loaded, their state and tool names. No model call. */
  mcpStatus(): Promise<McpServerState[]>;
  /** Stops the thread's process (Claude) or unloads it (Codex). The thread can be resumed later. */
  close(): Promise<void>;
}

/** One turn: iterate it for its events, or await `result`. */
export interface Turn extends AsyncIterable<AgentEvent> {
  readonly threadId: string;
  /** The turn ID, once the runtime has started the turn. */
  readonly id: Promise<string>;
  /** Adds a message to this running turn. Throws `SteerRejectedError` when it has ended. */
  steer(input: TurnInput): Promise<void>;
  /** Asks the runtime to stop the turn; `result` then settles with status `interrupted`. */
  interrupt(): Promise<void>;
  /** Settles when the turn ends, however it ends. Never rejects. */
  readonly result: Promise<TurnResult>;
}

/** The last turn on a thread, as `Thread.lastTurn` reads it. */
export interface LastTurn {
  turnId?: string;
  status: "completed" | "interrupted" | "failed" | "running" | "unknown";
  /** The agent's last message in that turn; empty when it sent none. */
  text: string;
}

/** How a turn ended. */
export interface TurnResult {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed";
  /** The final agent message, when there is one. */
  text: string;
  usage?: TokenUsage;
  error?: TurnError;
}

/** Why a turn failed, classified so a consumer can react (retry later, sign in…). */
export interface TurnError {
  kind: "usage-limit" | "rate-limit" | "context-window" | "auth" | "model" | "connection" | "other";
  message: string;
  /** When a usage or rate limit resets, if the runtime said. */
  resetsAt?: Date;
}

/** Token counts. Input includes cached input. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Context window of the model, when known. */
  contextWindow?: number;
}

/** A usage or rate limit report. */
export interface RateLimit {
  status: "ok" | "warning" | "rejected";
  /** Runtime's own name for the window (`five_hour`, `primary`…). */
  window?: string;
  /** 0–100, when known. */
  usedPercent?: number;
  resetsAt?: Date;
}

/** A tool call, normalised enough to render a step. */
export interface ToolCall {
  /** `command` for shell, `mcp` for MCP tools, `web-search`, `host` for host-answered tools, `builtin` for the rest. */
  kind: "command" | "mcp" | "web-search" | "host" | "builtin";
  /** Tool name: `Bash`, `mcp__notes__search`, `exec`… */
  name: string;
  /** MCP server, for `mcp` calls. */
  server?: string;
  input: unknown;
}

/** One file a turn changed. */
export interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
  /** Unified diff, when the runtime gives one. */
  diff?: string;
}

/**
 * What an agent message is for, when the runtime says (Codex): `commentary` is a
 * progress note between tool calls, `answer` is the reply itself. Claude does
 * not mark its messages, so its text events leave it out.
 */
export type MessagePhase = "commentary" | "answer";

/**
 * One step of the agent's working checklist: Codex's plan updates, Claude's
 * TodoWrite list.
 */
export interface PlanStep {
  step: string;
  status: "pending" | "in-progress" | "completed";
}

/**
 * What the runtime is doing between visible output, for a status line.
 *
 * - `working`: a model request or tool step is under way.
 * - `waiting`: blocked on the user; `waitingOn` says on what, when the runtime does.
 * - `compacting`: summarising the context.
 * - `retrying`: a failed model request will be retried; the turn has not failed.
 * - `idle`: nothing running.
 */
export interface RuntimeStatus {
  state: "working" | "waiting" | "compacting" | "retrying" | "idle";
  waitingOn?: Array<"approval" | "input">;
  /** For `retrying`, whatever the runtime reported about the attempt. */
  retry?: { attempt?: number; maxAttempts?: number; delayMs?: number; message?: string };
}

/** Lifecycle of a background task or subagent, as far as the runtime reports it. */
export type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

/** Work a task has done so far. */
export interface TaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** Fields every event has. `agentId` is set on events from a subagent. */
interface EventBase {
  threadId: string;
  /** Turn the event belongs to; empty for thread-level events outside a turn. */
  turnId: string;
  agentId?: string;
}

/** The normalised event stream. Runtime-specific detail is in `raw` where kept. */
export type AgentEvent = EventBase &
  (
    | { type: "turn.started" }
    | { type: "text.delta"; itemId: string; delta: string; phase?: MessagePhase }
    | { type: "text.done"; itemId: string; text: string; phase?: MessagePhase }
    | { type: "reasoning.delta"; itemId: string; delta: string }
    | { type: "reasoning.done"; itemId: string; text: string }
    | { type: "tool.started"; itemId: string; tool: ToolCall }
    | { type: "tool.completed"; itemId: string; tool: ToolCall; output?: string; isError: boolean }
    /** Live output of a running command, in order. `tool.completed` still carries the whole output. */
    | { type: "tool.output.delta"; itemId: string; delta: string }
    /** A running tool's progress: a message from the tool (Codex MCP) or time elapsed (Claude). */
    | { type: "tool.progress"; itemId: string; message?: string; elapsedSeconds?: number }
    | { type: "file.changed"; itemId: string; changes: FileChange[] }
    /** The turn's combined unified diff so far, replacing the previous one (Codex). */
    | { type: "diff.updated"; diff: string }
    /** The agent's checklist, whole each time. `itemId` is the tool call that set it, when there is one. */
    | { type: "plan.updated"; steps: PlanStep[]; explanation?: string; itemId?: string }
    /** A plan proposed for review, streamed (Codex plan mode). Use `plan.proposal.done` as the final text. */
    | { type: "plan.proposal.delta"; itemId: string; delta: string }
    | { type: "plan.proposal.done"; itemId: string; text: string }
    | { type: "status"; status: RuntimeStatus }
    /**
     * A background task that is not a subagent started (Claude: a background
     * shell, monitor, workflow or MCP task). `itemId` is the tool call that started it.
     */
    | { type: "task.started"; taskId: string; kind: string; description: string; itemId?: string; background?: boolean }
    /** Progress on a task or a subagent; for a subagent, `taskId` is its `subagentId`. */
    | {
      type: "task.progress";
      taskId: string;
      status?: TaskStatus;
      description?: string;
      /** A one-line summary of what it is doing now, when the runtime makes one. */
      summary?: string;
      lastTool?: string;
      usage?: TaskUsage;
      background?: boolean;
      error?: string;
    }
    | { type: "task.ended"; taskId: string; status: "completed" | "failed" | "stopped"; summary?: string; outputFile?: string; usage?: TaskUsage }
    | { type: "subagent.started"; subagentId: string; description?: string; prompt?: string; model?: string }
    | { type: "subagent.ended"; subagentId: string; status: "completed" | "failed" | "stopped"; summary?: string }
    | { type: "request"; request: AgentRequest }
    | { type: "request.resolved"; requestId: string }
    | { type: "usage"; usage: TokenUsage }
    | { type: "rate-limit"; limit: RateLimit }
    | { type: "compacted"; beforeTokens?: number; afterTokens?: number }
    | { type: "model.rerouted"; from: string; to: string }
    | { type: "turn.completed"; status: "completed" | "interrupted"; text: string; usage?: TokenUsage }
    | { type: "turn.failed"; error: TurnError; usage?: TokenUsage }
  );

/** A question or approval the runtime is waiting on. Call `respond` exactly once. */
export type AgentRequest = ApprovalRequest | QuestionRequest | ElicitationRequest;

/** The agent wants to do something that needs permission. */
export interface ApprovalRequest {
  kind: "approval";
  id: string;
  /** What it wants: run a command, change files, use a tool, widen its permissions. */
  action: "command" | "file-change" | "tool" | "permissions";
  /** One line for the UI. */
  title: string;
  command?: string;
  cwd?: string;
  tool?: string;
  input?: unknown;
  reason?: string;
  /**
   * For `file-change`: the changes waiting on this approval, when the runtime
   * announced them before asking (Codex sends them on the item it is approving).
   */
  changes?: FileChange[];
  /** The runtime's own request, for anything not normalised. */
  raw: unknown;
  respond(decision: { decision: "allow" | "allow-session" | "deny" | "cancel"; message?: string }): Promise<void>;
}

/** The agent asked the user one or more questions. */
export interface QuestionRequest {
  kind: "question";
  id: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
    allowOther: boolean;
    secret: boolean;
  }>;
  raw: unknown;
  /** Answers by question `id`; several labels for multi-select. An empty object declines. */
  respond(answers: Record<string, string[]>): Promise<void>;
}

/** An MCP server asked the user for input or to open a URL. */
export interface ElicitationRequest {
  kind: "elicitation";
  id: string;
  server: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  schema?: unknown;
  raw: unknown;
  respond(answer: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }): Promise<void>;
}

/** One step of a stored transcript, for subagents. */
export type TranscriptEntry =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: ToolCall; output?: string; isError?: boolean };

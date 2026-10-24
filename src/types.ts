/**
 * @file The provider-neutral surface: engines, threads, turns and the one event
 * stream both runtimes are normalised into.
 *
 * Nothing here decides policy. Which tools run, who approves what and how long a
 * turn may take are the consumer's choices, passed in as options; the engines
 * only translate them into each runtime's native settings.
 */

/** The runtimes this library drives: Codex, Claude, and any agent that speaks ACP. */
export type ProviderId = "codex" | "claude" | "acp";

/**
 * One runtime: its catalogue, sign-in and threads. Create with `createEngine`.
 *
 * Every method exists on every engine. One the runtime cannot do throws
 * `UnsupportedFeatureError`; `capabilities()` says which those are, so a UI can
 * hide the control rather than wait for the error.
 */
export interface Engine {
  readonly provider: ProviderId;
  /** Whether the runtime is installed, recent enough and signed in on a subscription. Never throws. */
  availability(): Promise<Availability>;
  /** What this runtime can do, for showing only the controls that work. */
  capabilities(): Promise<Capabilities>;
  /** The models and efforts the signed-in runtime offers right now. */
  models(): Promise<ModelInfo[]>;
  /**
   * How much of the signed-in plan is used, window by window. Asks the runtime
   * now; no model is called. Never throws for an account without plan limits:
   * `available` is false instead.
   */
  usage(): Promise<UsageReport>;
  /**
   * The slash commands and skills a thread in `cwd` would have: the user's,
   * the project's and the runtime's own. No model is called.
   */
  commands(options?: { cwd?: string }): Promise<CommandInfo[]>;
  /** Starts a new thread. Its ID is known straight away and can be saved to resume it later. */
  startThread(options: ThreadOptions): Promise<Thread>;
  /** Reopens a saved thread in the same `cwd`; history stays with the runtime. */
  resumeThread(threadId: string, options: ThreadOptions): Promise<Thread>;
  /**
   * Deletes what this Mac keeps of a thread: the runtime's session files and,
   * for subagents this engine saw, theirs too. Safe on a thread already gone.
   */
  deleteThread(threadId: string, options: { cwd: string }): Promise<void>;
  /**
   * Starts a new thread from a copy of a saved one, through `throughTurnId`
   * (inclusive) or the whole of it. The original is left as it was.
   */
  forkThread(threadId: string, options: ForkOptions): Promise<Thread>;
  /** Saved threads, newest first: ones this library started and ones the runtime's own apps did. */
  listThreads(options?: ListThreadsOptions): Promise<ThreadSummary[]>;
  /** A saved thread's summary and turns, read back from the runtime. No model is called. */
  readThread(threadId: string, options: { cwd: string }): Promise<ThreadHistory>;
  /** Sets the title the runtime shows for a thread. */
  renameThread(threadId: string, title: string, options: { cwd: string }): Promise<void>;
  /** Moves a thread out of the runtime's list without deleting it. */
  archiveThread(threadId: string, options: { cwd: string }): Promise<void>;
  unarchiveThread(threadId: string, options: { cwd: string }): Promise<void>;
  /** Starts a sign-in the user finishes in a browser: a URL to open, or a URL and a code to type. */
  login(options?: { method?: "browser" | "device-code" }): Promise<LoginFlow>;
  logout(): Promise<void>;
  /**
   * Gets the runtime ready before the first message, so the first reply comes
   * sooner. With thread options, Claude also opens that thread's process now and
   * hands it to the next `startThread` with the same options.
   */
  prewarm(options?: ThreadOptions): Promise<void>;
  /** Files under `cwd` matching `query` fuzzily, best first: for `@` mentions in a composer. */
  searchFiles(query: string, options: { cwd: string; limit?: number }): Promise<FileMatch[]>;
  /** The runtime's effective settings for a folder, as it reads them. For a settings screen. */
  config(options?: { cwd?: string }): Promise<EffectiveConfig>;
  /** Installed and available plugins. */
  plugins(options?: { cwd?: string }): Promise<PluginInfo[]>;
  installPlugin(plugin: { name: string; marketplace?: string }): Promise<void>;
  uninstallPlugin(pluginId: string): Promise<void>;
  /** Turns one of the user's skills on or off for every thread. */
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  /** Engine-wide events: sign-in changes and notices that belong to no thread. Returns an unsubscribe function. */
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** Stops every thread and the runtime process. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * What a runtime can do. A `false` means the matching method throws
 * `UnsupportedFeatureError`; a string says how the engine does it where the
 * runtimes differ.
 */
export interface Capabilities {
  provider: ProviderId;
  /** `Turn.steer` adds to a running turn. */
  steer: boolean;
  /** `Thread.compact`. */
  compact: boolean;
  /** `Engine.forkThread`. */
  fork: boolean;
  /** `Thread.rewind` drops later turns from the conversation. */
  rewind: boolean;
  /**
   * `Thread.rewind` with `files: true` also restores the files those turns
   * changed. Claude needs `fileCheckpoints: true` on the thread. Codex restores
   * a git snapshot the engine took before the turn when the thread has
   * `fileCheckpoints` and its folder is in a git repository, and otherwise
   * undoes the edits Codex recorded.
   */
  rewindFiles: boolean;
  /** `listThreads`, `readThread` and `Thread.history`. */
  history: boolean;
  /** `renameThread`, `Thread.rename` and `ThreadOptions.title`. */
  rename: boolean;
  /** `archiveThread` and `unarchiveThread`. */
  archive: boolean;
  /** Access levels the runtime has a native setting for. */
  access: Access[];
  /** `mode` values the runtime can switch between. */
  modes: ThreadMode[];
  /** `outputSchema` on a turn or thread, with the parsed reply in `TurnResult.output`. */
  structuredOutput: boolean;
  /** `Thread.contextUsage`. */
  contextUsage: boolean;
  /** Images in `TurnInput`. */
  images: boolean;
  /**
   * Files in `TurnInput`: `content` sends PDFs and text files as content the
   * model reads; `paths` names them in the message for the agent to open.
   */
  files: "content" | "paths";
  /** `Thread.setGoal`, `goal` and `clearGoal`: work that runs over several turns. */
  goals: boolean;
  /** `Thread.review`: the runtime's own code review, or a review prompt the engine writes. */
  review: "native" | "prompt" | false;
  /** `Thread.shell`. */
  shell: boolean;
  /** `Thread.tasks`. */
  listTasks: boolean;
  /** `Thread.stopTask`. */
  stopTask: boolean;
  /** Live MCP management on a thread. */
  mcp: { setServers: boolean; reconnect: boolean; toggle: boolean; login: boolean; readResource: boolean };
  /** `Engine.login`. */
  login: boolean;
  /** `Engine.logout`. */
  logout: boolean;
  /** `hook.started` and `hook.completed` events. */
  hookEvents: boolean;
  /** Host hook callbacks (`claude.hooks`). */
  hookCallbacks: boolean;
  /** Which of `ThreadOptions.limits` the runtime enforces. */
  limits: Array<keyof TurnLimits>;
  /** How `ThreadOptions.seed` reaches the model: as history (`native`) or as context in the first message (`prompt`). */
  handoff: "native" | "prompt";
  /** `Engine.prewarm` does more than start the runtime: it opens the next thread's process ahead of time. */
  prewarmThreads: boolean;
  /** `Engine.searchFiles`: the runtime's own index, or a local search of the folder. */
  fileSearch: "native" | "local";
  /** `ThreadOptions.agents`. */
  agents: boolean;
  /** `Thread.reloadSkills` and `Engine.setSkillEnabled`. */
  skills: { reload: boolean; toggle: boolean };
  /** `Engine.plugins`, `installPlugin` and `uninstallPlugin`, and `Thread.reloadPlugins`. */
  plugins: { list: boolean; install: boolean; reload: boolean };
  /** `Engine.config`. */
  config: boolean;
  /** `Thread.realtime`: a live voice or text session. */
  realtime: boolean;
  /** `prompt.suggestion` events when `ThreadOptions.promptSuggestions` is on. */
  promptSuggestions: boolean;
  /** Which live progress events the runtime sends. */
  liveOutput: { commandOutput: boolean; diff: boolean; planProposal: boolean };
}

/** Settings for `Engine.forkThread`: the new thread's options, and where to cut. */
export interface ForkOptions extends ThreadOptions {
  /** Last turn to keep, inclusive. Omitted keeps every turn. */
  throughTurnId?: string;
}

/** Filters for `Engine.listThreads`. */
export interface ListThreadsOptions {
  /** Only threads started in this folder. */
  cwd?: string;
  /** Most threads to return. Defaults to 50. */
  limit?: number;
  /** Archived threads instead of the active ones (Codex). */
  archived?: boolean;
  /** Only threads whose title or first message contains this text. */
  search?: string;
}

/** One saved thread, as the runtime lists it. */
export interface ThreadSummary {
  id: string;
  provider: ProviderId;
  cwd?: string;
  title?: string;
  /** Usually the first user message. */
  preview?: string;
  createdAt?: Date;
  updatedAt?: Date;
  /** The thread this one was forked from. */
  forkedFrom?: string;
  model?: string;
  gitBranch?: string;
  archived?: boolean;
}

/** A thread read back with its turns. */
export interface ThreadHistory extends ThreadSummary {
  turns: HistoryTurn[];
}

/** One turn of a saved thread. Its `id` is the one `fork`, `rewind` and `interruptTurn` take. */
export interface HistoryTurn {
  id: string;
  status: LastTurn["status"];
  /** What the user sent and what came back, in order. */
  entries: TranscriptEntry[];
  startedAt?: Date;
}

/** Result of `Thread.rewind`. */
export interface RewindResult {
  /** Turns dropped from the conversation. */
  droppedTurns: number;
  /**
   * For `files: true`: the files put back, and how. `checkpoint` restored the
   * runtime's or the engine's own snapshot; `edits` undid the recorded edits,
   * which leaves files a shell command wrote, and `skipped` lists files whose
   * text no longer matched.
   */
  files?: { paths: string[]; insertions?: number; deletions?: number; method?: "checkpoint" | "edits"; skipped?: string[] };
}

/** A sign-in started by `Engine.login`. */
export interface LoginFlow {
  /** Open this in a browser. */
  url: string;
  /** For a device-code sign-in: the code to type at `url`. */
  code?: string;
  /** Settles when the sign-in finishes, however it ends. Never rejects. */
  done: Promise<{ success: boolean; error?: string }>;
  cancel(): Promise<void>;
}

/** A file `Engine.searchFiles` found. */
export interface FileMatch {
  /** Relative to the `cwd` searched. */
  path: string;
  /** Higher is better; only comparable within one search. */
  score: number;
  /** Character positions in `path` that matched, when known. */
  indices?: number[];
}

/** `Engine.config`: the settings the runtime would use, as it reports them. */
export interface EffectiveConfig {
  provider: ProviderId;
  /** The merged settings. Shapes are the runtime's own. */
  values: Record<string, unknown>;
  /** Where the settings came from, highest priority last, when the runtime says. */
  sources?: Array<{ name: string; path?: string; values: Record<string, unknown> }>;
}

/** One plugin. */
export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  installed: boolean;
  enabled?: boolean;
  marketplace?: string;
  version?: string;
}

/** An event that belongs to the engine rather than one thread. */
export type EngineEvent =
  | { type: "account.changed"; provider: ProviderId; signedIn: boolean; plan?: string }
  | { type: "notice"; provider: ProviderId; kind: NoticeKind; message: string; details?: string; raw?: unknown };

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

/** One usage window of the signed-in plan. */
export interface UsageWindow {
  /** `session` is the short window (about five hours); the others are calendar-length. */
  kind: "session" | "weekly" | "monthly" | "other";
  /** The runtime's own name for it (`five_hour`, `seven_day`, `codex`…). */
  name: string;
  /** The model family the window is limited to, when it is one (`Fable`). */
  model?: string;
  /** 0–100. */
  usedPercent: number;
  resetsAt?: Date;
}

/** Result of `Engine.usage()`. */
export interface UsageReport {
  provider: ProviderId;
  checkedAt: Date;
  /** False when the account has no plan limits to report (an API key), or the runtime would not say. */
  available: boolean;
  /** Plan name on a subscription (`plus`, `max`…). */
  plan?: string;
  windows: UsageWindow[];
  /** Codex: banked credits that clear the current windows. */
  resetCredits?: number;
}

/** A slash command or skill a thread can use. */
export interface CommandInfo {
  name: string;
  /**
   * `command` runs when a message starts with `/name`. `skill` is a skill the
   * agent loads by name (Codex reads `$name` anywhere in a message).
   */
  kind: "command" | "skill";
  description?: string;
  /** What follows the command, e.g. `<file>`. */
  argumentHint?: string;
  /** The runtime's own, rather than the user's, a project's or a plugin's. */
  builtin?: boolean;
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
 * - `auto`: the runtime's own reviewer approves routine actions and asks about the rest
 *   (Codex's auto review, Claude's auto mode).
 * - `accept-edits`: file edits go ahead; other actions still ask. Codex's workspace
 *   sandbox already lets edits in the folder through, so there it is the same as `ask`.
 * - `ask`: the runtime's defaults, with anything needing approval surfaced as a `request` event.
 * - `read-only`: no writes; anything that would need approval is refused.
 *
 * Provider options (`codex.approvalPolicy`, `claude.permissionMode`…) override this.
 */
export type Access = "full" | "auto" | "accept-edits" | "ask" | "read-only";

/**
 * How the agent works. `plan` researches and proposes a plan without changing
 * anything (Codex plan mode, Claude plan mode); `default` does the work.
 */
export type ThreadMode = "default" | "plan";

/** Limits a runtime enforces on a thread's turns. */
export interface TurnLimits {
  /** Model round trips per turn (Claude). */
  maxTurns?: number;
  /** Spend per process, in US dollars, as Claude Code prices it (Claude). */
  maxBudgetUsd?: number;
  /** Output tokens the model is told it has for the task, so it can pace itself (Claude task budget). */
  tokenBudget?: number;
}

/** A custom subagent the main agent can hand work to. */
export interface AgentDefinition {
  /** When to use it; the main agent reads this. */
  description: string;
  /** Its instructions. */
  prompt: string;
  model?: string;
  /** Tools it may use (Claude). Codex ignores this. */
  tools?: string[];
}

/** Settings for a thread, used on start and again on resume. */
export interface ThreadOptions {
  /** Absolute working directory. A resumed thread must use the one it started in. */
  cwd: string;
  model?: string;
  effort?: string;
  /** Codex `fast` service tier, or Claude fast mode. */
  fastMode?: boolean;
  access?: Access;
  /** `plan` to research and propose before changing anything. Defaults to `default`. */
  mode?: ThreadMode;
  /** Extra instructions: Codex developer instructions, appended to Claude's system prompt. */
  instructions?: string;
  mcpServers?: Record<string, McpServer>;
  /** Extra environment for the agent's tools (Claude); Codex takes env on the engine. */
  env?: Record<string, string>;
  /** Fails a turn that the runtime silently moves to another model. Defaults to true. */
  strictModel?: boolean;
  /** Title for a new thread; a resumed one keeps its own (use `rename`). */
  title?: string;
  /** JSON Schema every reply must match; the parsed reply is `TurnResult.output`. A turn's own schema wins. */
  outputSchema?: Record<string, unknown>;
  /** Limits the runtime enforces; see `Capabilities.limits` for which. */
  limits?: TurnLimits;
  /** Custom subagents, by name. */
  agents?: Record<string, AgentDefinition>;
  /** Folders the agent may use besides `cwd`, as absolute paths. */
  additionalDirectories?: string[];
  /**
   * Keep a copy of the files before each turn, so `rewind` can put them back:
   * Claude's file checkpointing, or on Codex a git snapshot of the folder before
   * each turn this library starts (the folder must be in a git repository).
   * Off by default.
   */
  fileCheckpoints?: boolean;
  /**
   * Earlier conversation for a new thread to carry on from: another thread's
   * `export()`, so work can move between runtimes. Codex adds it to the thread's
   * history; the others put it before the first message. Ignored on resume.
   */
  seed?: PortableTranscript;
  /**
   * Models to try in order when the chosen one is overloaded (Claude). A switch
   * to one of these is not treated as a silent model swap under `strictModel`.
   */
  fallbackModels?: string[];
  /** Ask the runtime for suggested next prompts after each turn (`prompt.suggestion` events; Claude). */
  promptSuggestions?: boolean;
  /**
   * One-line summaries of what running subagents are doing, on `task.progress`
   * (Claude). Each costs a small model call, so it is off unless asked for.
   */
  progressSummaries?: boolean;
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
  /**
   * Hook callbacks the host answers, in the SDK's shape (`PreToolUse`,
   * `PostToolUse`, `Stop`…). Their runs also arrive as `hook.*` events.
   */
  hooks?: Record<string, unknown[]>;
  /** Local plugins to load, in the SDK's shape (`{ type: "local", path }`). */
  plugins?: Array<{ type: "local"; path: string }>;
  /** Any other SDK `query` option, merged last. */
  extra?: Record<string, unknown>;
}

/** What a user sends: text, and optionally images and files. */
export type TurnInput = string | { text: string; images?: ImageInput[]; files?: FileInput[] };

/** An image sent with a turn. */
export type ImageInput =
  | { type: "path"; path: string }
  | { type: "base64"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string };

/**
 * A file sent with a turn: a PDF, a text file, anything. Where the runtime
 * reads documents (`Capabilities.files` is `content`), PDFs and text go in as
 * content; anything else, and every file elsewhere, is named by path in the
 * message for the agent to open itself.
 */
export type FileInput =
  | { type: "path"; path: string; name?: string; mediaType?: string }
  | { type: "base64"; name: string; mediaType: string; data: string };

/** Per-turn changes; they also stick for later turns, as both runtimes do. */
export interface TurnOptions {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  /** A new access level from this turn on. */
  access?: Access;
  /** A new mode from this turn on: `plan` to propose first, `default` to do the work. */
  mode?: ThreadMode;
  /**
   * JSON Schema this turn's reply must match. The parsed reply is
   * `TurnResult.output`. On Claude a schema is set per process, so changing it
   * restarts the thread's process before the turn (history is kept).
   */
  outputSchema?: Record<string, unknown> | null;
}

/** What a code review looks at. */
export type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "base-branch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

/** How full a thread's context window is. */
export interface ContextUsage {
  /** Tokens in the context now. */
  usedTokens: number;
  /** The window's size, when known. */
  maxTokens?: number;
  /** 0–100, when the size is known. */
  percent?: number;
  /** Where the tokens go (system prompt, tools, messages…), when the runtime breaks it down (Claude). */
  categories?: Array<{ name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }>;
}

/** A goal a thread keeps working towards over several turns (Codex `/goal`). */
export interface Goal {
  objective: string;
  status: "active" | "paused" | "blocked" | "usage-limited" | "budget-limited" | "complete";
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

/** A background task: a shell the agent left running, a monitor, a subagent. */
export interface TaskInfo {
  id: string;
  /** `shell`, `subagent`, `monitor`, `workflow`, `mcp`… */
  kind: string;
  description: string;
  status: TaskStatus;
}

/** What `Thread.setMcpServers` changed. */
export interface McpChangeResult {
  added: string[];
  removed: string[];
  /** Servers that failed to start, with why. */
  errors: Record<string, string>;
}

/** One piece of an MCP resource. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64. */
  blob?: string;
}

/**
 * A thread's conversation in a form any runtime can take: what `export()`
 * returns and `ThreadOptions.seed` accepts.
 */
export interface PortableTranscript {
  provider: ProviderId;
  threadId: string;
  turns: HistoryTurn[];
}

/** Settings for `Thread.realtime`. */
export interface RealtimeOptions {
  /** `audio` to hear replies (`realtime.audio` events); `text` for transcripts only. Defaults to `text`. */
  output?: "text" | "audio";
  /** Instructions for the realtime model. */
  instructions?: string;
  model?: string;
}

/** Raw audio for a realtime session. */
export interface AudioChunk {
  /** Base64 PCM16. */
  data: string;
  sampleRate: number;
  channels: number;
}

/** A live realtime session on a thread (Codex). Its output arrives as `realtime.*` events. */
export interface RealtimeSession {
  /** Sends text as the user (or as context). */
  sendText(text: string, role?: "user" | "developer"): Promise<void>;
  /** Sends a chunk of microphone audio. */
  sendAudio(audio: AudioChunk): Promise<void>;
  stop(): Promise<void>;
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
  /**
   * Drops `beforeTurnId` and every later turn from the conversation, so the
   * next message carries on from just before it: how "edit an earlier prompt"
   * works (rewind, then `run` the edited text). With `files: true` the files
   * those turns changed are put back too, where `Capabilities.rewindFiles`.
   * No turn may be running.
   */
  rewind(beforeTurnId: string, options?: { files?: boolean }): Promise<RewindResult>;
  /** Every turn so far, read back from the runtime. */
  history(): Promise<HistoryTurn[]>;
  /** Sets the thread's title. */
  rename(title: string): Promise<void>;
  /** How full the context window is now. No model call. */
  contextUsage(): Promise<ContextUsage>;
  /** Sets a goal the agent keeps working towards, turn after turn, until it is met or paused. */
  setGoal(objective: string, options?: { tokenBudget?: number }): Promise<Goal>;
  goal(): Promise<Goal | undefined>;
  clearGoal(): Promise<void>;
  /** Reviews code as a turn of its own; the review is the turn's text. */
  review(target: ReviewTarget): Turn;
  /** Runs a shell command in the thread, as the user (`!cmd`); it shows in the thread like the agent's own. */
  shell(command: string, options?: { timeoutMs?: number }): Promise<void>;
  /** Background tasks still running: shells, monitors, subagents. */
  tasks(): Promise<TaskInfo[]>;
  stopTask(taskId: string): Promise<void>;
  /** Replaces the thread's own MCP servers while it runs. */
  setMcpServers(servers: Record<string, McpServer>): Promise<McpChangeResult>;
  /** Restarts one MCP server (Codex reloads them all). */
  reconnectMcp(server: string): Promise<void>;
  toggleMcp(server: string, enabled: boolean): Promise<void>;
  /** Starts an MCP server's OAuth sign-in; open the URL. */
  mcpLogin(server: string): Promise<{ url: string }>;
  readMcpResource(server: string, uri: string): Promise<McpResourceContent[]>;
  /** Reloads skills from disk and returns the thread's commands afterwards. */
  reloadSkills(): Promise<CommandInfo[]>;
  /** Reloads plugins from disk. */
  reloadPlugins(): Promise<void>;
  /** The conversation in a form another runtime can carry on from (`ThreadOptions.seed`). */
  export(): Promise<PortableTranscript>;
  /** Opens a live voice or text session on the thread. */
  realtime(options?: RealtimeOptions): Promise<RealtimeSession>;
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
  /** With an `outputSchema`: the reply, parsed. Undefined when it was not valid JSON. */
  output?: unknown;
  usage?: TokenUsage;
  error?: TurnError;
}

/**
 * Why a turn failed, classified so a consumer can react (retry later, sign in…).
 * `limit` is one of the thread's own `limits` (too many round trips, the budget spent).
 */
export interface TurnError {
  kind: "usage-limit" | "rate-limit" | "context-window" | "auth" | "model" | "connection" | "limit" | "other";
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
  /** Absolute path. For a move, where the file was before. */
  path: string;
  kind: "add" | "delete" | "update";
  /** For a move: where the file is now. */
  movedTo?: string;
  /**
   * Unified diff hunks (`@@ -a,b +c,d @@` then `+`, `-` and ` ` lines), with no
   * `---`/`+++` header. A new file is all `+`, a deleted one all `-`. Left out
   * when the runtime does not say what changed (Claude's NotebookEdit).
   */
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
    /** Something the runtime wants the user to know that is not part of the reply: a warning, a refusal, a denied tool. */
    | { type: "notice"; kind: NoticeKind; message: string; details?: string; raw?: unknown }
    /** A hook (the user's, a project's, a plugin's or the host's) started or finished. */
    | { type: "hook.started"; hookId: string; event: string; name?: string }
    | { type: "hook.completed"; hookId: string; event: string; name?: string; status: "completed" | "failed" | "blocked" | "stopped"; output?: string }
    /** The thread's goal changed; `goal` is null once cleared. */
    | { type: "goal.updated"; goal: Goal | null }
    /** An MCP server's state changed (started, ready, failed, needs sign-in). */
    | { type: "mcp.status"; server: string; status: string; error?: string; needsLogin?: boolean }
    | { type: "thread.renamed"; title: string }
    /** A suggested next prompt, after a turn (`promptSuggestions`). */
    | { type: "prompt.suggestion"; suggestion: string }
    | { type: "realtime.started"; sessionId?: string }
    | { type: "realtime.transcript.delta"; role: string; delta: string }
    | { type: "realtime.transcript.done"; role: string; text: string }
    | { type: "realtime.audio"; audio: AudioChunk }
    | { type: "realtime.error"; message: string }
    | { type: "realtime.closed"; reason?: string }
    | { type: "turn.completed"; status: "completed" | "interrupted"; text: string; output?: unknown; usage?: TokenUsage }
    | { type: "turn.failed"; error: TurnError; usage?: TokenUsage }
  );

/**
 * What a notice is about. `warning` and `config` are the runtime's warnings,
 * `deprecation` a feature on its way out, `refusal` the model declining,
 * `permission-denied` a tool call a rule refused, `moderation` a safety check,
 * `info` anything else the runtime chose to show.
 */
export type NoticeKind = "warning" | "config" | "deprecation" | "refusal" | "permission-denied" | "moderation" | "info";

/** A question or approval the runtime is waiting on. Call `respond` exactly once. */
export type AgentRequest = ApprovalRequest | QuestionRequest | ElicitationRequest;

/** The agent wants to do something that needs permission. */
export interface ApprovalRequest {
  kind: "approval";
  id: string;
  /**
   * What it wants: run a command, change files, use a tool, widen its
   * permissions, or (`plan`) leave plan mode and carry out the plan in `plan`.
   * Allowing a plan ends plan mode; denying it, with a message, keeps planning.
   */
  action: "command" | "file-change" | "tool" | "permissions" | "plan";
  /** For `plan`: the proposed plan. */
  plan?: string;
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

/** One step of a stored transcript. */
export type TranscriptEntry =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: ToolCall; output?: string; isError?: boolean }
  | { kind: "files"; changes: FileChange[] };

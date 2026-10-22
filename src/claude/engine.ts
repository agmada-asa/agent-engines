/**
 * @file The Claude engine, over the Claude Agent SDK. Each thread is one Claude
 * Code process in streaming-input mode: `run` sends a user message, `steer`
 * sends another while the turn runs, and a `result` message ends the turn. The
 * thread ID is the Claude session ID, chosen here so it is known before the
 * first prompt and can be resumed later in the same `cwd`.
 *
 * If the process exits, the running turn fails with a `connection` error and the
 * next call starts a new process on the same session.
 */

import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readdir, rm, rmdir } from "node:fs/promises";
import * as sdkModule from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpServerConfig,
  OnElicitation,
  Options,
  PermissionResult,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentEngineError,
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeModelUnavailableError,
  SteerRejectedError,
} from "../errors.ts";
import { checkMinimumVersion } from "../compat.ts";
import { TurnHandle, emitTo, inputParts } from "../turn.ts";
import type {
  AgentEvent,
  AgentRequest,
  Availability,
  Engine,
  LastTurn,
  McpServerState,
  ModelInfo,
  Thread,
  ThreadOptions,
  TranscriptEntry,
  Turn,
  TurnInput,
  TurnOptions,
  TurnResult,
} from "../types.ts";
import { ClaudeNormalizer, claudeTranscript, claudeUsage, classifyClaudeError } from "./normalize.ts";

/** Oldest Claude Code this library has been checked against. */
export const CLAUDE_CODE_MIN_VERSION = "2.1.248";

/** Environment variables that would make Claude Code bill an API key instead of the subscription. */
const API_KEY_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/** How long the no-prompt probe waits for Claude Code to initialise. */
const PROBE_TIMEOUT_MS = 30_000;

/** Built-in tools that change files or run commands; off in `read-only` access. */
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

/** The SDK functions the engine uses; tests inject a fake. */
export type ClaudeSdk = Readonly<Pick<typeof sdkModule, "query" | "deleteSession" | "getSubagentMessages" | "getSessionInfo" | "getSessionMessages">>;

/** Engine-wide settings for Claude. */
export interface ClaudeEngineOptions {
  /** SDK functions; defaults to the real Claude Agent SDK. */
  sdk?: ClaudeSdk;
  /** Claude Code executable; defaults to the binary the SDK bundles. */
  executable?: string;
  /** Base environment for every Claude Code process; defaults to the current one. A plain record, so apps whose `ProcessEnv` requires keys (Next.js) can pass one. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Refuse to run unless Claude is signed in with a Claude subscription, and strip
   * API-key variables from the child, so turns never bill per token. Defaults to true.
   */
  requireSubscription?: boolean;
  /** Oldest Claude Code version accepted. */
  minimumVersion?: string;
  /** Claude's config directory, for `deleteThread`; defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir?: string;
}

/** Turns a `TurnInput` into SDK message content. */
function claudeContent(input: TurnInput): SDKUserMessage["message"]["content"] {
  const { text, images } = inputParts(input);
  if (!images.length) return text;
  return [
    { type: "text", text },
    ...images.map((image) => {
      if (image.type === "base64") return { type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } };
      throw new AgentEngineError("Claude takes images as base64; read the file and pass { type: \"base64\" }.");
    }),
  ];
}

/** A user message for the input stream. */
function userMessage(input: TurnInput, priority?: "next"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: claudeContent(input) },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  } as SDKUserMessage;
}

/** An async iterable the engine pushes user messages into; it ends only when told. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting?: () => void;
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.ended) throw new RuntimeConnectionError("The Claude Code process has ended.");
    this.items.push(message);
    this.waiting?.();
  }

  end(): void {
    this.ended = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
      this.waiting = undefined;
    }
  }
}

/** One catalogue row in the neutral shape. */
export function claudeModelInfo(model: SDKControlInitializeResponse["models"][number]): ModelInfo {
  return {
    id: model.value,
    label: model.displayName || model.value,
    ...(model.description ? { description: model.description } : {}),
    efforts: [...(model.supportedEffortLevels ?? [])],
    fastMode: model.supportsFastMode === true,
    isDefault: model.value === "default",
    ...(model.resolvedModel && model.resolvedModel !== model.value ? { resolvedModel: model.resolvedModel } : {}),
  };
}

/** Availability from the init result's account. */
function accountAvailability(init: SDKControlInitializeResponse, requireSubscription: boolean, minimumVersion: string): Availability {
  const version = init.claude_code_version;
  const tooOld = version ? checkMinimumVersion(version, minimumVersion) : undefined;
  if (tooOld) return { provider: "claude", ready: false, reason: "unsupported-version", message: `Claude Code ${version} is too old: ${tooOld}.`, version };
  const account = init.account ?? {};
  const onKey = Boolean((account.apiKeySource && account.apiKeySource !== "none") || (account.apiProvider && account.apiProvider !== "firstParty"));
  const versionField = version ? { version } : {};
  if (account.subscriptionType && !onKey) {
    return {
      provider: "claude",
      ready: true,
      reason: "ready",
      message: "Claude is signed in with a Claude subscription.",
      ...versionField,
      account: { kind: "subscription", plan: account.subscriptionType, ...(account.email ? { email: account.email } : {}) },
    };
  }
  if (onKey) {
    return requireSubscription
      ? { provider: "claude", ready: false, reason: "api-key", message: "Claude is using an API key, which bills per token. Run `claude` and sign in with your Claude subscription instead.", ...versionField, account: { kind: "api-key" } }
      : { provider: "claude", ready: true, reason: "ready", message: "Claude is signed in.", ...versionField, account: { kind: "api-key" } };
  }
  return { provider: "claude", ready: false, reason: "signed-out", message: "Claude is not signed in. Run `claude` and sign in, then try again.", ...versionField };
}

/** Claude through the Claude Agent SDK. */
export class ClaudeEngine implements Engine {
  readonly provider = "claude" as const;
  private readonly sdk: ClaudeSdk;
  private readonly threads = new Set<ClaudeThread>();

  constructor(readonly options: ClaudeEngineOptions = {}) {
    this.sdk = options.sdk ?? sdkModule;
  }

  async availability(): Promise<Availability> {
    try {
      const init = await this.probe();
      return accountAvailability(init, this.options.requireSubscription !== false, this.minimumVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found/iu.test(message)) {
        return { provider: "claude", ready: false, reason: "missing-executable", message: "Claude Code could not be found. Install it or set the engine's executable." };
      }
      return { provider: "claude", ready: false, reason: "probe-failed", message: `Claude Code did not start: ${message}` };
    }
  }

  async models(): Promise<ModelInfo[]> {
    return (await this.probe()).models.map(claudeModelInfo);
  }

  async startThread(options: ThreadOptions): Promise<Thread> {
    const thread = new ClaudeThread(this, this.sdk, options, randomUUID(), false);
    await thread.open();
    this.threads.add(thread);
    return thread;
  }

  async resumeThread(threadId: string, options: ThreadOptions): Promise<Thread> {
    // A session is written only once a prompt reaches Claude; one that never got one opens fresh under the same ID.
    const exists = await Promise.resolve().then(() => this.sdk.getSessionInfo(threadId, { dir: options.cwd })).then(Boolean, () => true);
    const thread = new ClaudeThread(this, this.sdk, options, threadId, exists);
    await thread.open();
    this.threads.add(thread);
    return thread;
  }

  /**
   * Deletes the session transcript (the SDK's `deleteSession`), then the files
   * Claude Code keeps beside it: subagent transcripts, session environment,
   * file history, todos, debug logs and shell snapshots.
   */
  async deleteThread(threadId: string, options: { cwd: string }): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) throw new AgentEngineError("That is not a Claude session ID.");
    const owner = [...this.threads].find((thread) => thread.id === threadId);
    await owner?.close();
    const home = this.options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    const mine = (name: string) => name === threadId || name.startsWith(`${threadId}.`) || name.startsWith(`${threadId}-`);
    // Found before deleteSession removes the transcript, so emptied project folders can be tidied after.
    const projects = join(home, "projects");
    const holders: string[] = [];
    for (const project of await readdir(projects).catch(() => [] as string[])) {
      if ((await readdir(join(projects, project)).catch(() => [] as string[])).some(mine)) holders.push(join(projects, project));
    }
    await this.sdk.deleteSession(threadId, { dir: options.cwd }).catch(() => undefined);
    for (const dir of holders) {
      await removeMatching(dir, mine);
      // A project folder this thread emptied goes too; `rmdir` leaves one with anything still in it.
      await removeIfEmpty(dir, ["memory"]);
    }
    for (const dir of ["session-env", "file-history", "todos", "debug", "shell-snapshots"]) await removeMatching(join(home, dir), mine);
  }

  async close(): Promise<void> {
    for (const thread of [...this.threads]) await thread.close().catch(() => undefined);
  }

  /** @internal */
  forget(thread: ClaudeThread): void {
    this.threads.delete(thread);
  }

  /** @internal */
  get minimumVersion(): string {
    return this.options.minimumVersion ?? CLAUDE_CODE_MIN_VERSION;
  }

  /** @internal The child environment: base plus thread extras, minus API keys when required. */
  environment(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "agent-engines" };
    for (const [key, value] of Object.entries({ ...(this.options.env ?? process.env), ...extra })) {
      if (value !== undefined) env[key] = value;
    }
    if (this.options.requireSubscription !== false) for (const name of API_KEY_VARIABLES) delete env[name];
    return env;
  }

  /** Starts Claude Code without a prompt, reads its init result and stops it. No model is called. */
  private async probe(): Promise<SDKControlInitializeResponse> {
    const input = new InputQueue();
    const probe = this.sdk.query({
      prompt: input,
      options: {
        cwd: tmpdir(),
        env: this.environment(),
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        tools: [],
        persistSession: false,
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe.initializationResult(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AgentEngineError("Claude Code did not initialise in time.")), PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      input.end();
      probe.close();
    }
  }
}

/** Removes entries of a directory whose names match; returns how many. */
async function removeMatching(dir: string, match: (name: string) => boolean): Promise<number> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(match);
  for (const name of names) await rm(join(dir, name), { recursive: true, force: true });
  return names.length;
}

/** Removes a directory if nothing is left in it but the named subfolders, themselves empty. */
async function removeIfEmpty(dir: string, emptySubfolders: string[]): Promise<void> {
  for (const name of emptySubfolders) await rmdir(join(dir, name)).catch(() => undefined);
  await rmdir(dir).catch(() => undefined);
}

/** One Claude session and the Claude Code process serving it. */
class ClaudeThread implements Thread {
  readonly provider = "claude" as const;
  private readonly normalizer: ClaudeNormalizer;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingRequests = new Set<() => void>();
  private query?: Query;
  private input?: InputQueue;
  private current?: TurnHandle;
  private last?: LastTurn;
  private interruptRequested = false;
  private lastText = "";
  private expectedModel?: string;
  private prompted: boolean;
  private closed = false;

  constructor(
    private readonly engine: ClaudeEngine,
    private readonly sdk: ClaudeSdk,
    private readonly options: ThreadOptions,
    readonly id: string,
    resumed: boolean,
  ) {
    if (!isAbsolute(options.cwd)) throw new AgentEngineError("A thread needs an absolute cwd.");
    this.normalizer = new ClaudeNormalizer(id);
    this.prompted = resumed;
  }

  get activeTurn(): Turn | undefined {
    return this.current && !this.current.done ? this.current : undefined;
  }

  /**
   * Starts the Claude Code process and checks, before any prompt, the sign-in,
   * the version and (unless `strictModel` is false) that the model and effort
   * are in the catalogue.
   */
  async open(): Promise<void> {
    const input = new InputQueue();
    const abortController = new AbortController();
    const query = this.sdk.query({ prompt: input, options: this.sdkOptions(abortController) });
    this.input = input;
    this.query = query;
    let init: SDKControlInitializeResponse;
    try {
      init = await query.initializationResult();
      const state = accountAvailability(init, this.engine.options.requireSubscription !== false, this.engine.minimumVersion);
      if (state.reason === "unsupported-version") throw new RuntimeCompatibilityError(state.message);
      if (!state.ready) throw new RuntimeAuthError(state.message);
      this.checkModel(init);
    } catch (error) {
      input.end();
      query.close();
      this.query = undefined;
      throw error;
    }
    void this.pump(query);
  }

  run(input: TurnInput, turnOptions: TurnOptions = {}): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; steer it or wait for it to end.");
    const turn = this.newTurn();
    void (async () => {
      try {
        const query = await this.ready();
        if (turnOptions.model) await query.setModel(turnOptions.model);
        const flags: Record<string, unknown> = {};
        if (turnOptions.effort) flags.effortLevel = turnOptions.effort;
        if (turnOptions.fastMode !== undefined) flags.fastMode = turnOptions.fastMode;
        if (Object.keys(flags).length) await query.applyFlagSettings(flags as Parameters<Query["applyFlagSettings"]>[0]);
        this.send(userMessage(input));
      } catch (error) {
        this.failTurn(turn, error);
      }
    })();
    return turn;
  }

  compact(): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; compact after it ends.");
    const turn = this.newTurn();
    void this.ready().then(() => this.send(userMessage("/compact")), (error) => this.failTurn(turn, error));
    return turn;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subagentTranscript(agentId: string): Promise<TranscriptEntry[]> {
    const messages = await this.sdk.getSubagentMessages(this.id, agentId, { dir: this.options.cwd });
    return claudeTranscript(messages);
  }

  async lastTurn(): Promise<LastTurn | undefined> {
    if (this.current && !this.current.done) return { turnId: this.current.turnId!, status: "running", text: "" };
    if (this.last) return this.last;
    const messages = await this.sdk.getSessionMessages(this.id, { dir: this.options.cwd }).catch(() => []);
    const entries = claudeTranscript(messages.filter((message) => !message.parent_tool_use_id));
    if (!entries.length) return undefined;
    const reply = [...entries].reverse().find((entry) => entry.kind === "message" && entry.role === "assistant");
    return { status: "unknown", text: reply?.kind === "message" ? reply.text : "" };
  }

  async interruptTurn(turnId: string): Promise<void> {
    if (this.current && !this.current.done && this.current.turnId === turnId) await this.current.interrupt();
  }

  async mcpStatus(): Promise<McpServerState[]> {
    const query = await this.ready();
    return (await query.mcpServerStatus()).map((server) => ({
      name: server.name,
      status: server.status,
      tools: (server.tools ?? []).map((tool) => tool.name),
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelRequests();
    if (this.current && !this.current.done) this.finish(this.current, { status: "interrupted" });
    this.engine.forget(this);
    this.input?.end();
    this.query?.close();
    this.query = undefined;
  }

  private newTurn(): TurnHandle {
    const turn: TurnHandle = new TurnHandle(this.id, {
      steer: async (input) => {
        if (turn.done || this.current !== turn) throw new SteerRejectedError("The turn has ended; start a new one.");
        this.send(userMessage(input, "next"));
      },
      interrupt: async () => {
        if (turn.done || this.current !== turn) return;
        this.interruptRequested = true;
        await this.query?.interrupt();
      },
    });
    turn.setId(randomUUID());
    this.current = turn;
    this.interruptRequested = false;
    this.lastText = "";
    this.normalizer.startTurn();
    this.dispatch({ threadId: this.id, turnId: turn.turnId!, type: "turn.started" });
    return turn;
  }

  /** The live query, starting a new process on the same session if the last one ended. */
  private async ready(): Promise<Query> {
    if (this.closed) throw new AgentEngineError("This thread is closed.");
    if (!this.query) await this.open();
    return this.query!;
  }

  private send(message: SDKUserMessage): void {
    if (!this.input) throw new RuntimeConnectionError("The Claude Code process has ended.");
    this.input.push(message);
    this.prompted = true;
  }

  /** Reads the process's messages until it ends. */
  private async pump(query: Query): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of query) this.handle(message);
    } catch (error) {
      failure = error;
    }
    if (this.query !== query) return;
    this.query = undefined;
    this.input?.end();
    this.cancelRequests();
    if (this.current && !this.current.done && !this.closed) {
      // The SDK throws when the process dies; that is a lost connection, not the turn's own failure.
      const lost = failure instanceof AgentEngineError
        ? failure
        : new RuntimeConnectionError(failure instanceof Error ? `Claude Code exited: ${failure.message}` : "Claude Code exited before the turn finished.", { cause: failure });
      this.failTurn(this.current, lost);
    }
  }

  private handle(message: SDKMessage): void {
    const m = message as Record<string, any>;
    if (m.type === "system" && m.subtype === "init") {
      if (this.expectedModel && this.options.strictModel !== false && m.model !== this.expectedModel && m.model !== this.options.model && this.current && !this.current.done) {
        this.failTurn(this.current, Object.assign(new AgentEngineError(`Claude Code selected ${m.model}; ${this.options.model} was requested.`), { kind: "model" }));
        void this.query?.interrupt().catch(() => undefined);
      }
      return;
    }
    // The agent can start a turn on its own, such as when a background subagent reports back.
    const mainOutput = !m.parent_tool_use_id && !m.agent_id && (m.type === "assistant" || (m.type === "stream_event" && m.event?.type === "message_start"));
    if (mainOutput && (!this.current || this.current.done)) this.newTurn();
    const turn = this.current && !this.current.done ? this.current : undefined;
    for (const event of this.normalizer.normalize(message, turn?.turnId ?? "")) {
      if (event.type === "text.done" && !event.agentId) this.lastText = event.text;
      this.dispatch(event);
      if (event.type === "model.rerouted" && this.options.strictModel !== false && turn) {
        this.failTurn(turn, Object.assign(new AgentEngineError(`Claude switched from ${event.from} to ${event.to}.`), { kind: "model" }));
        void this.query?.interrupt().catch(() => undefined);
      }
    }
    if (m.type === "result" && turn) {
      // A steer Claude could not fold into this turn runs as the next one; the turn covers both.
      if (typeof m.queued_turn_count === "number" && m.queued_turn_count > 0) return;
      const usage = claudeUsage(m.modelUsage);
      if (this.interruptRequested) this.finish(turn, { status: "interrupted", usage });
      else if (m.subtype === "success" && !m.is_error) this.finish(turn, { status: "completed", text: String(m.result ?? this.lastText), usage });
      else {
        const detail = m.subtype === "success" ? String(m.result ?? "") : (m.errors ?? []).filter(Boolean).join("; ") || m.subtype;
        this.finish(turn, { status: "failed", usage, error: classifyClaudeError(detail, this.normalizer.assistantError, this.normalizer.lastLimit) });
      }
    }
  }

  private finish(turn: TurnHandle, outcome: { status: TurnResult["status"]; text?: string; usage?: ReturnType<typeof claudeUsage>; error?: TurnResult["error"] }): void {
    if (turn.done) return;
    const base = { threadId: this.id, turnId: turn.turnId! };
    const usage = outcome.usage ? { usage: outcome.usage } : {};
    const event: AgentEvent = outcome.status === "failed"
      ? { ...base, type: "turn.failed", error: outcome.error ?? { kind: "other", message: "The Claude turn failed." }, ...usage }
      : { ...base, type: "turn.completed", status: outcome.status, text: outcome.text ?? (outcome.status === "interrupted" ? this.lastText : ""), ...usage };
    this.dispatch(event);
    this.cancelRequests();
    this.last = { turnId: base.turnId, status: outcome.status, text: event.type === "turn.completed" ? event.text : "" };
    turn.finish({
      ...base,
      status: outcome.status,
      text: event.type === "turn.completed" ? event.text : "",
      ...usage,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  private failTurn(turn: TurnHandle, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const kind = (error as { kind?: string })?.kind === "model" || error instanceof RuntimeModelUnavailableError
      ? "model"
      : error instanceof RuntimeAuthError ? "auth" : error instanceof RuntimeConnectionError ? "connection" : "other";
    this.finish(turn, { status: "failed", error: { kind, message } });
  }

  private dispatch(event: AgentEvent): void {
    const turn = this.current;
    if (turn && !turn.done && event.turnId === turn.turnId) turn.push(event);
    emitTo(this.listeners, event);
  }

  /** Requires the model and effort to be in the catalogue, so a typo fails before the turn. */
  private checkModel(init: SDKControlInitializeResponse): void {
    const { model, effort } = this.options;
    if (!model || this.options.strictModel === false) return;
    const row = init.models.find((entry) => entry.value === model || entry.resolvedModel === model);
    if (!row) throw new RuntimeModelUnavailableError(`Claude does not offer ${model}.`);
    if (effort && row.supportedEffortLevels && !row.supportedEffortLevels.includes(effort as never)) {
      throw new RuntimeModelUnavailableError(`Claude does not offer ${model} with ${effort} effort.`);
    }
    this.expectedModel = row.resolvedModel ?? row.value;
  }

  /** SDK options for this thread: neutral settings first, Claude-specific overrides after. */
  private sdkOptions(abortController: AbortController): Options {
    const { options } = this;
    const claude = options.claude ?? {};
    const access: Partial<Options> =
      options.access === "full" ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
      : options.access === "read-only" ? { permissionMode: "dontAsk", disallowedTools: WRITE_TOOLS }
      : options.access === "ask" ? { permissionMode: "default" }
      : {};
    const settings: Record<string, unknown> = {};
    if (options.fastMode !== undefined) settings.fastMode = options.fastMode;
    const permissionMode = claude.permissionMode ?? access.permissionMode;
    return {
      cwd: options.cwd,
      env: this.engine.environment(options.env),
      abortController,
      includePartialMessages: true,
      forwardSubagentText: claude.forwardSubagentText ?? true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort as Options["effort"] } : {}),
      systemPrompt: claude.systemPrompt ?? { type: "preset", preset: "claude_code", ...(options.instructions ? { append: options.instructions } : {}) },
      ...access,
      ...(permissionMode ? { permissionMode } : {}),
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(options.mcpServers ? { mcpServers: claudeMcpServers(options.mcpServers) } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(claude.settingSources ? { settingSources: claude.settingSources } : {}),
      ...(claude.tools ? { tools: claude.tools } : {}),
      ...(claude.allowedTools ? { allowedTools: claude.allowedTools } : {}),
      ...(claude.disallowedTools || access.disallowedTools ? { disallowedTools: [...(access.disallowedTools ?? []), ...(claude.disallowedTools ?? [])] } : {}),
      ...(claude.strictMcpConfig !== undefined ? { strictMcpConfig: claude.strictMcpConfig } : {}),
      ...(claude.skills !== undefined ? { skills: claude.skills } : {}),
      ...((claude.executable ?? this.engine.options.executable) ? { pathToClaudeCodeExecutable: claude.executable ?? this.engine.options.executable } : {}),
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      // A session exists once a prompt reached Claude; before that, a new process opens it fresh under the same ID.
      ...(this.prompted ? { resume: this.id } : { sessionId: this.id }),
      ...(claude.extra ?? {}),
    } as Options;
  }

  /** Permission prompts and AskUserQuestion, surfaced as `request` events. */
  private readonly canUseTool: CanUseTool = (toolName, input, context) =>
    new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const settle = (result: PermissionResult) => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(cancel);
        resolve(result);
      };
      const cancel = () => settle({ behavior: "deny", message: "The request was cancelled." });
      this.pendingRequests.add(cancel);
      context.signal.addEventListener("abort", cancel, { once: true });
      const id = (context as { toolUseID?: string }).toolUseID ?? randomUUID();
      let request: AgentRequest;
      if (toolName === "AskUserQuestion") {
        const questions: Array<Record<string, any>> = Array.isArray(input.questions) ? input.questions : [];
        request = {
          kind: "question",
          id,
          questions: questions.map((question) => ({
            id: String(question.question),
            header: String(question.header ?? ""),
            question: String(question.question ?? ""),
            options: (question.options ?? []).map((option: Record<string, unknown>) => ({ label: String(option.label), description: String(option.description ?? "") })),
            multiSelect: question.multiSelect === true,
            allowOther: true,
            secret: false,
          })),
          raw: input,
          respond: async (answers) => {
            if (!Object.keys(answers).length) return settle({ behavior: "deny", message: "The user chose not to answer." });
            const joined = Object.fromEntries(Object.entries(answers).map(([question, labels]) => [question, labels.join(", ")]));
            settle({ behavior: "allow", updatedInput: { ...input, answers: joined } });
          },
        };
      } else {
        const action = toolName === "Bash" ? "command" : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName) ? "file-change" : "tool";
        request = {
          kind: "approval",
          id,
          action,
          title: context.title ?? `Use ${toolName}`,
          tool: toolName,
          input,
          ...(typeof input.command === "string" ? { command: input.command } : {}),
          ...(context.decisionReason ? { reason: context.decisionReason } : {}),
          raw: { toolName, input, suggestions: context.suggestions },
          respond: async ({ decision, message }) => {
            if (decision === "allow") settle({ behavior: "allow", updatedInput: input });
            else if (decision === "allow-session") settle({ behavior: "allow", updatedInput: input, ...(context.suggestions ? { updatedPermissions: context.suggestions } : {}) });
            else settle({ behavior: "deny", message: message ?? "The user declined this.", ...(decision === "cancel" ? { interrupt: true } : {}) });
          },
        };
      }
      this.dispatch({ threadId: this.id, turnId: this.current && !this.current.done ? this.current.turnId! : "", type: "request", request });
    });

  /** MCP elicitations, surfaced as `request` events. */
  private readonly onElicitation: OnElicitation = (elicitation, context) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (result: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(cancel);
        resolve(result as never);
      };
      const cancel = () => settle({ action: "cancel" });
      this.pendingRequests.add(cancel);
      context.signal.addEventListener("abort", cancel, { once: true });
      const request: AgentRequest = {
        kind: "elicitation",
        id: context.requestId,
        server: elicitation.serverName,
        message: elicitation.message,
        mode: elicitation.mode === "url" ? "url" : "form",
        ...(elicitation.url ? { url: elicitation.url } : {}),
        ...(elicitation.requestedSchema ? { schema: elicitation.requestedSchema } : {}),
        raw: elicitation,
        respond: async ({ action, content }) => settle({ action, ...(content ? { content } : {}) }),
      };
      this.dispatch({ threadId: this.id, turnId: this.current && !this.current.done ? this.current.turnId! : "", type: "request", request });
    });

  private cancelRequests(): void {
    for (const cancel of [...this.pendingRequests]) cancel();
  }
}

/** Thread MCP servers in the SDK's shape. */
function claudeMcpServers(servers: NonNullable<ThreadOptions["mcpServers"]>): Record<string, McpServerConfig> {
  const config: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new AgentEngineError(`MCP server name ${JSON.stringify(name)} cannot be used safely.`);
    const alwaysLoad = server.type !== "sdk" && server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {};
    if (server.type === "http") {
      config[name] = { type: "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}), ...alwaysLoad };
    } else if (server.type === "sdk") {
      config[name] = server as McpServerConfig;
    } else {
      if (server.cwd) throw new AgentEngineError(`Claude cannot set a working directory for MCP server ${name}; wrap the command instead.`);
      config[name] = { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}), ...alwaysLoad };
    }
  }
  return config;
}

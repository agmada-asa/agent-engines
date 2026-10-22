/**
 * @file The Codex engine: one `codex app-server` child shared by every thread
 * the engine opens. Threads, turns, steering, interrupts and compaction map to
 * the app-server's own methods; notifications go through `CodexNormalizer`.
 *
 * If the child exits, running turns fail with a `connection` error and the next
 * call starts a fresh child and resumes the thread, so a crash costs one turn.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  AgentEngineError,
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeModelSubstitutionError,
  SteerRejectedError,
} from "../errors.ts";
import { TurnHandle, emitTo, inputParts } from "../turn.ts";
import type {
  Access,
  AgentEvent,
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
import {
  CodexClient,
  CodexRpcError,
  type CodexLaunchOptions,
  type CodexNotification,
  type SpawnCodexProcess,
} from "./client.ts";
import { CodexNormalizer, codexRequest, codexTool, type PendingCodexRequest } from "./normalize.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { Model } from "./protocol/v2/Model.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";

/** The service tier Codex calls fast mode. */
const FAST_TIER = "priority";

/** Environment variables that would make Codex bill an API key instead of the ChatGPT sign-in. */
const API_KEY_VARIABLES = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];

/** A host-answered tool call (a thread's `codex.dynamicTools`). */
export interface CodexToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  namespace: string | null;
  arguments: unknown;
}

/** Engine-wide settings for Codex. */
export interface CodexEngineOptions {
  /** Codex executable; defaults to `codex` on PATH. */
  executable?: string;
  /** Environment for the app-server and the commands it runs; defaults to the current one. */
  env?: NodeJS.ProcessEnv;
  /** Process-wide launch flags: disabled features, `--config` overrides. */
  launch?: CodexLaunchOptions;
  /**
   * Refuse to run unless Codex is signed in with ChatGPT (a subscription), and
   * strip API-key variables from the child. Defaults to true.
   */
  requireSubscription?: boolean;
  /** Oldest serving version accepted; defaults to the version the bindings were generated from. */
  minimumVersion?: string;
  requestTimeoutMs?: number;
  /** Answers `codex.dynamicTools` calls; without it they fail. */
  onToolCall?: (call: CodexToolCall) => Promise<{ text: string; success: boolean }>;
  /** Client name the app-server records. */
  clientName?: string;
  /** Injectable process factory for tests. */
  spawnProcess?: SpawnCodexProcess;
}

/** Child environment: the caller's, minus API keys when only a subscription may be billed. */
function codexEnvironment(options: CodexEngineOptions): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  if (options.requireSubscription !== false) for (const name of API_KEY_VARIABLES) delete env[name];
  return env;
}

/** Thread-level approval and sandbox settings for an access level. */
function threadAccess(access: Access | undefined): Pick<ThreadStartParams, "approvalPolicy" | "sandbox"> {
  switch (access) {
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "ask":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "read-only":
      return { approvalPolicy: "never", sandbox: "read-only" };
    default:
      return {};
  }
}

/** Codex `UserInput` items for a turn. */
function codexInput(input: TurnInput): UserInput[] {
  const { text, images } = inputParts(input);
  const items: UserInput[] = [{ type: "text", text, text_elements: [] }];
  for (const image of images) {
    items.push(image.type === "path"
      ? { type: "localImage", path: image.path }
      : { type: "image", url: `data:${image.mediaType};base64,${image.data}` });
  }
  return items;
}

/** One catalogue entry in the neutral shape. */
export function codexModelInfo(model: Model): ModelInfo {
  return {
    id: model.model || model.id,
    label: model.displayName || model.model || model.id,
    ...(model.description ? { description: model.description } : {}),
    efforts: [...new Set(model.supportedReasoningEfforts.map((option) => option.reasoningEffort))],
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
    fastMode: model.serviceTiers.some((tier) => tier.id === FAST_TIER),
    isDefault: model.isDefault,
    hidden: model.hidden,
    inputModalities: [...model.inputModalities],
  };
}

/** Codex through `codex app-server`. */
export class CodexEngine implements Engine {
  readonly provider = "codex" as const;
  private client?: Promise<CodexClient>;
  private readonly threads = new Set<CodexThread>();
  private closed = false;

  constructor(readonly options: CodexEngineOptions = {}) {}

  async availability(): Promise<Availability> {
    let client: CodexClient;
    try {
      client = await this.connection();
    } catch (error) {
      if (error instanceof RuntimeCompatibilityError) {
        return { provider: "codex", ready: false, reason: "unsupported-version", message: error.message };
      }
      if (error instanceof RuntimeAuthError) return this.authAvailability(error);
      const missing = /ENOENT/u.test(String((error as Error)?.message)) || ((error as Error)?.cause as NodeJS.ErrnoException)?.code === "ENOENT";
      return missing
        ? { provider: "codex", ready: false, reason: "missing-executable", message: "Codex is not installed. Install it with `npm install -g @openai/codex`." }
        : { provider: "codex", ready: false, reason: "probe-failed", message: `Codex did not start: ${(error as Error)?.message ?? "unknown error"}` };
    }
    const account = await client.request<GetAccountResponse>("account/read", {}).catch(() => undefined);
    return { ...accountAvailability(account, this.options.requireSubscription !== false), version: client.serverVersion };
  }

  async models(): Promise<ModelInfo[]> {
    const client = await this.connection();
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response: ModelListResponse = await client.request<ModelListResponse>("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) });
      models.push(...response.data.map(codexModelInfo));
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return models;
  }

  async startThread(options: ThreadOptions): Promise<Thread> {
    const thread = new CodexThread(this, options);
    await thread.open();
    this.threads.add(thread);
    return thread;
  }

  async resumeThread(threadId: string, options: ThreadOptions): Promise<Thread> {
    const thread = new CodexThread(this, options, threadId);
    await thread.open();
    this.threads.add(thread);
    return thread;
  }

  async deleteThread(threadId: string, _options: { cwd: string }): Promise<void> {
    const client = await this.connection();
    const owner = [...this.threads].find((thread) => thread.id === threadId);
    // Subagents this engine saw, and any Codex still records from earlier runs.
    const ids = [...new Set([...(owner?.subagentIds ?? []), ...(await descendantThreadIds(client, threadId)), threadId])];
    if (owner) await owner.close();
    for (const id of ids) {
      await client.request("thread/delete", { threadId: id }).catch((error: unknown) => {
        // A thread already deleted, or never written, is the outcome asked for.
        if (!(error instanceof CodexRpcError) || !/not found|no rollout found|no such|does not exist|unknown thread/iu.test(error.message)) throw error;
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const thread of [...this.threads]) await thread.close().catch(() => undefined);
    const client = await this.client?.catch(() => undefined);
    await client?.close();
    this.client = undefined;
  }

  /** @internal Forgets a closed thread. */
  forget(thread: CodexThread): void {
    this.threads.delete(thread);
  }

  /** @internal The shared app-server connection, started on first use and again after a crash. */
  connection(): Promise<CodexClient> {
    if (this.closed) return Promise.reject(new AgentEngineError("This Codex engine is closed."));
    if (!this.client) {
      const connecting = this.connect();
      this.client = connecting;
      connecting.catch(() => {
        if (this.client === connecting) this.client = undefined;
      });
    }
    return this.client;
  }

  private async connect(): Promise<CodexClient> {
    const client = await CodexClient.connect({
      cwd: homedir(),
      env: codexEnvironment(this.options),
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.launch ? { launch: this.options.launch } : {}),
      ...(this.options.minimumVersion ? { minimumVersion: this.options.minimumVersion } : {}),
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
      clientName: this.options.clientName ?? "agent-engines",
      onServerRequest: (request) => this.serverRequest(request),
    });
    if (this.options.requireSubscription !== false) {
      const account = await client.request<GetAccountResponse>("account/read", {}).catch(() => undefined);
      const state = accountAvailability(account, true);
      if (!state.ready) {
        await client.close();
        throw new RuntimeAuthError(state.message, { cause: state });
      }
    }
    client.onNotification((notification) => this.route(notification));
    client.onClose((error) => {
      // The next call starts a fresh child; threads resume themselves on it.
      this.client = undefined;
      for (const thread of this.threads) thread.lost(error);
    });
    return client;
  }

  private authAvailability(error: RuntimeAuthError): Availability {
    const state = error.cause as Availability | undefined;
    return state ?? { provider: "codex", ready: false, reason: "signed-out", message: error.message };
  }

  private route(notification: CodexNotification): void {
    const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId;
    for (const thread of this.threads) {
      if (threadId === undefined || thread.owns(threadId)) thread.handle(notification);
    }
  }

  private async serverRequest(request: { id: number | string; method: string; params: unknown }): Promise<unknown> {
    const params = (request.params ?? {}) as { threadId?: string; turnId?: string; callId?: string; tool?: string; namespace?: string | null; arguments?: unknown };
    if (request.method === "item/tool/call") {
      if (!this.options.onToolCall) return undefined;
      try {
        const result = await this.options.onToolCall({
          threadId: String(params.threadId),
          turnId: String(params.turnId),
          callId: String(params.callId),
          tool: String(params.tool),
          namespace: params.namespace ?? null,
          arguments: params.arguments,
        });
        return { contentItems: [{ type: "inputText", text: result.text }], success: result.success };
      } catch {
        return { contentItems: [{ type: "inputText", text: "The tool call could not be completed." }], success: false };
      }
    }
    const thread = [...this.threads].find((candidate) => candidate.owns(params.threadId));
    return thread?.request(request.id, request.method, request.params);
  }
}

/**
 * Every subagent thread spawned under `threadId`, at any depth, as Codex records
 * them. Empty when the runtime cannot say, so callers fall back to what they saw.
 */
async function descendantThreadIds(client: CodexClient, threadId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const params: ThreadListParams = { ancestorThreadId: threadId, archived, limit: 100, ...(cursor ? { cursor } : {}) };
      const response: ThreadListResponse | undefined = await client.request<ThreadListResponse>("thread/list", params).catch(() => undefined);
      if (!response) return [...ids];
      for (const thread of response.data) ids.add(thread.id);
      cursor = response.nextCursor;
      if (!cursor) break;
    }
  }
  return [...ids];
}

/** Availability from `account/read`. */
function accountAvailability(response: GetAccountResponse | undefined, requireSubscription: boolean): Availability {
  const account = response?.account;
  if (!account) {
    return { provider: "codex", ready: false, reason: "signed-out", message: "Codex is not signed in. Run `codex login` and sign in with ChatGPT." };
  }
  if (account.type === "chatgpt") {
    return {
      provider: "codex",
      ready: true,
      reason: "ready",
      message: "Codex is signed in with ChatGPT.",
      account: { kind: "subscription", plan: String(account.planType), ...(account.email ? { email: account.email } : {}) },
    };
  }
  const kind = account.type === "apiKey" ? "api-key" : "other";
  if (requireSubscription) {
    return {
      provider: "codex",
      ready: false,
      reason: "api-key",
      message: "Codex is signed in with an API key, which bills per token. Run `codex login` and sign in with ChatGPT instead.",
      account: { kind },
    };
  }
  return { provider: "codex", ready: true, reason: "ready", message: "Codex is signed in.", account: { kind } };
}

/** One Codex thread and the subagent threads it spawns. */
class CodexThread implements Thread {
  readonly provider = "codex" as const;
  id: string;
  private normalizer: CodexNormalizer;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingRequests = new Map<string, PendingCodexRequest>();
  private current?: TurnHandle;
  private loadedOn?: CodexClient;
  private closed = false;

  constructor(
    private readonly engine: CodexEngine,
    private readonly options: ThreadOptions,
    resumeId?: string,
  ) {
    if (!isAbsolute(options.cwd)) throw new AgentEngineError("A thread needs an absolute cwd.");
    this.id = resumeId ?? "";
    this.normalizer = new CodexNormalizer(this.id);
  }

  get activeTurn(): Turn | undefined {
    return this.current && !this.current.done ? this.current : undefined;
  }

  get subagentIds(): string[] {
    return this.normalizer.subagentIds;
  }

  owns(threadId: unknown): boolean {
    return Boolean(this.id) && this.normalizer.owns(threadId);
  }

  /** Starts or resumes the thread on the current connection. */
  async open(): Promise<void> {
    const client = await this.engine.connection();
    const { options } = this;
    const config: Record<string, unknown> = { ...(options.codex?.config ?? {}) };
    if (options.mcpServers) config.mcp_servers = mcpConfig(options.mcpServers);
    const shared = {
      ...(options.model ? { model: options.model } : {}),
      cwd: options.cwd,
      ...threadAccess(options.access),
      ...(options.codex?.approvalPolicy ? { approvalPolicy: options.codex.approvalPolicy } : {}),
      ...(options.codex?.sandbox ? { sandbox: options.codex.sandbox } : {}),
      ...(Object.keys(config).length ? { config: config as ThreadStartParams["config"] } : {}),
      ...(options.instructions ? { developerInstructions: options.instructions } : {}),
      ...(options.codex?.baseInstructions ? { baseInstructions: options.codex.baseInstructions } : {}),
      ...(options.fastMode !== undefined ? { serviceTier: options.fastMode ? FAST_TIER : null } : {}),
    };
    let response: ThreadStartResponse;
    if (!this.id) {
      const params: ThreadStartParams = {
        ...shared,
        allowProviderModelFallback: options.strictModel === false,
        ephemeral: options.codex?.ephemeral ?? false,
        ...(options.codex?.dynamicTools ? { dynamicTools: options.codex.dynamicTools as ThreadStartParams["dynamicTools"] } : {}),
      };
      response = await client.request<ThreadStartResponse>("thread/start", params);
      this.id = response.thread.id;
      this.normalizer = new CodexNormalizer(this.id);
    } else {
      const params: ThreadResumeParams = { threadId: this.id, ...shared, excludeTurns: true };
      response = await client.request<ThreadStartResponse>("thread/resume", params);
    }
    if (options.model && options.strictModel !== false && response.model !== options.model) {
      throw new RuntimeModelSubstitutionError(options.model, response.model);
    }
    this.loadedOn = client;
  }

  run(input: TurnInput, turnOptions: TurnOptions = {}): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; steer it or wait for it to end.");
    const turn = this.newTurn();
    void this.startTurn(turn, input, turnOptions);
    return turn;
  }

  compact(): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; compact after it ends.");
    const turn = this.newTurn();
    void (async () => {
      try {
        const client = await this.ready();
        await client.request("thread/compact/start", { threadId: this.id });
      } catch (error) {
        this.failTurn(turn, error);
      }
    })();
    return turn;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subagentTranscript(agentId: string): Promise<TranscriptEntry[]> {
    const client = await this.ready();
    if (!this.normalizer.subagentIds.includes(agentId) && !(await descendantThreadIds(client, this.id)).includes(agentId)) {
      throw new AgentEngineError(`No subagent ${agentId} on this thread.`);
    }
    const entries: TranscriptEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response: ThreadTurnsListResponse = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
        threadId: agentId, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}),
      });
      for (const turn of response.data) for (const item of turn.items) entries.push(...transcriptEntries(item as Record<string, any>));
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return entries;
  }

  async lastTurn(): Promise<LastTurn | undefined> {
    if (this.current && !this.current.done) return { ...(this.current.turnId ? { turnId: this.current.turnId } : {}), status: "running", text: "" };
    const client = await this.ready();
    const response = await client.request<ThreadTurnsListResponse>("thread/turns/list", { threadId: this.id, sortDirection: "desc", limit: 1, itemsView: "full" });
    const turn = response.data[0];
    if (!turn) return undefined;
    const message = [...turn.items].reverse().find((item) => item.type === "agentMessage") as { text?: string } | undefined;
    return { turnId: turn.id, status: turn.status === "inProgress" ? "running" : turn.status, text: message?.text ?? "" };
  }

  async mcpStatus(): Promise<McpServerState[]> {
    const client = await this.ready();
    const servers: McpServerState[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response: ListMcpServerStatusResponse = await client.request<ListMcpServerStatusResponse>("mcpServerStatus/list", {
        threadId: this.id, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}),
      });
      for (const server of response.data) {
        servers.push({ name: server.name, status: String((server as { runtimeStatus?: unknown }).runtimeStatus ?? "unknown"), tools: Object.keys(server.tools ?? {}) });
      }
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return servers;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelRequests();
    if (this.current && !this.current.done) {
      this.current.finish({ threadId: this.id, turnId: this.current.turnId ?? "", status: "interrupted", text: "" });
    }
    this.engine.forget(this);
    if (this.loadedOn && !this.loadedOn.isClosed) await this.loadedOn.request("thread/unsubscribe", { threadId: this.id }).catch(() => undefined);
  }

  /** @internal Routes one notification. */
  handle(notification: CodexNotification): void {
    for (const event of this.normalizer.normalize(notification.method, notification.params)) this.dispatch(event);
  }

  /** @internal Surfaces one server request and waits for the consumer's answer. */
  async request(id: number | string, method: string, params: unknown): Promise<unknown> {
    const pending = codexRequest(id, method, params);
    if (!pending) return undefined;
    this.pendingRequests.set(pending.request.id, pending);
    const turnId = String((params as { turnId?: unknown })?.turnId ?? this.normalizer.currentTurnId);
    const agentId = (params as { threadId?: string })?.threadId !== this.id ? (params as { threadId?: string }).threadId : undefined;
    this.dispatch({ threadId: this.id, turnId, ...(agentId ? { agentId } : {}), type: "request", request: pending.request });
    try {
      return await pending.response;
    } finally {
      this.pendingRequests.delete(pending.request.id);
    }
  }

  /** @internal The connection dropped: fail the running turn and reload on next use. */
  lost(error: Error): void {
    this.loadedOn = undefined;
    this.cancelRequests();
    if (this.current && !this.current.done) this.failTurn(this.current, error);
  }

  private newTurn(): TurnHandle {
    const turn: TurnHandle = new TurnHandle(this.id, {
      steer: (input) => this.steer(turn, input),
      interrupt: () => this.interrupt(turn),
    });
    this.current = turn;
    return turn;
  }

  /** The connection, resuming the thread first if the child was restarted. */
  private async ready(): Promise<CodexClient> {
    if (this.closed) throw new AgentEngineError("This thread is closed.");
    const client = await this.engine.connection();
    if (this.loadedOn !== client) await this.open();
    return client;
  }

  private async startTurn(turn: TurnHandle, input: TurnInput, turnOptions: TurnOptions): Promise<void> {
    try {
      const client = await this.ready();
      const fastMode = turnOptions.fastMode;
      const params: TurnStartParams = {
        threadId: this.id,
        input: codexInput(input),
        ...(turnOptions.model ? { model: turnOptions.model } : {}),
        ...((turnOptions.effort ?? this.options.effort) ? { effort: turnOptions.effort ?? this.options.effort } : {}),
        ...(fastMode !== undefined ? { serviceTier: fastMode ? FAST_TIER : null } : {}),
      };
      const response = await client.request<TurnStartResponse>("turn/start", params);
      turn.setId(response.turn.id);
      if (!this.normalizer.currentTurnId) this.normalizer.currentTurnId = response.turn.id;
    } catch (error) {
      this.failTurn(turn, error);
    }
  }

  private async steer(turn: TurnHandle, input: TurnInput): Promise<void> {
    if (turn.done) throw new SteerRejectedError("The turn has ended; start a new one.");
    const turnId = await turn.id;
    const client = await this.ready();
    try {
      await client.request("turn/steer", { threadId: this.id, input: codexInput(input), expectedTurnId: turnId });
    } catch (error) {
      if (error instanceof CodexRpcError) throw new SteerRejectedError(error.message, { cause: error });
      throw error;
    }
  }

  private async interrupt(turn: TurnHandle): Promise<void> {
    if (turn.done) return;
    const turnId = await turn.id;
    const client = await this.ready();
    await client.request("turn/interrupt", { threadId: this.id, turnId });
  }

  private dispatch(event: AgentEvent): void {
    if (!event.agentId && event.type === "turn.started") {
      // A turn nobody asked for (compaction, or the agent waking itself) still gets a handle.
      if (!this.current || this.current.done) this.newTurn();
      this.current!.setId(event.turnId);
    }
    const turn = this.current;
    if (turn && !turn.done && (!turn.turnId || event.turnId === turn.turnId || event.type === "rate-limit")) {
      turn.push(event);
      if (!event.agentId && (event.type === "turn.completed" || event.type === "turn.failed") && event.turnId === turn.turnId) {
        this.cancelRequests();
        turn.finish(turnResult(event));
      }
    }
    emitTo(this.listeners, event);
  }

  private failTurn(turn: TurnHandle, error: unknown): void {
    if (turn.done) return;
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof RuntimeConnectionError ? "connection" : error instanceof RuntimeModelSubstitutionError ? "model" : "other";
    const event: AgentEvent = { threadId: this.id, turnId: turn.turnId ?? "", type: "turn.failed", error: { kind, message } };
    turn.push(event);
    emitTo(this.listeners, event);
    turn.finish(turnResult(event));
  }

  private cancelRequests(): void {
    for (const pending of this.pendingRequests.values()) pending.cancel();
    this.pendingRequests.clear();
  }
}

/** The settled result for a terminal event. */
function turnResult(event: AgentEvent): TurnResult {
  if (event.type === "turn.completed") {
    return { threadId: event.threadId, turnId: event.turnId, status: event.status, text: event.text, ...(event.usage ? { usage: event.usage } : {}) };
  }
  if (event.type === "turn.failed") {
    return { threadId: event.threadId, turnId: event.turnId, status: "failed", text: "", error: event.error, ...(event.usage ? { usage: event.usage } : {}) };
  }
  throw new AgentEngineError(`Not a terminal event: ${event.type}`);
}

/** Thread MCP servers as Codex `mcp_servers` config. */
function mcpConfig(servers: NonNullable<ThreadOptions["mcpServers"]>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new AgentEngineError(`MCP server name ${JSON.stringify(name)} cannot be used safely.`);
    if (server.type === "sdk") throw new AgentEngineError(`MCP server ${name} is an in-process Claude SDK server; Codex takes host tools through codex.dynamicTools.`);
    config[name] = server.type === "http"
      ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }
      : {
          command: server.command,
          args: server.args ?? [],
          ...(server.env ? { env: server.env } : {}),
          ...(server.cwd ? { cwd: server.cwd } : {}),
        };
  }
  return config;
}

/** A stored Codex item as transcript entries. */
function transcriptEntries(item: Record<string, any>): TranscriptEntry[] {
  switch (item.type) {
    case "userMessage": {
      const text = (item.content ?? []).map((part: any) => (part?.type === "text" ? part.text : "")).join("");
      return text ? [{ kind: "message", role: "user", text }] : [];
    }
    case "agentMessage":
      return item.text ? [{ kind: "message", role: "assistant", text: item.text }] : [];
    case "reasoning": {
      const text = [...(item.content ?? []), ...(item.content?.length ? [] : item.summary ?? [])].join("\n\n");
      return text ? [{ kind: "reasoning", text }] : [];
    }
    default: {
      const tool = codexTool(item);
      if (!tool) return [];
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
      return [{ kind: "tool", tool, ...(output ? { output } : {}), ...(item.status === "failed" ? { isError: true } : {}) }];
    }
  }
}

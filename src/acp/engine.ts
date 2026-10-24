/**
 * @file An engine for any agent that speaks the Agent Client Protocol (ACP):
 * OpenCode, Gemini CLI and others. One agent child per engine, shared by every
 * thread; a thread is an ACP session, a turn is one `session/prompt`.
 *
 * What an agent can do varies, so `capabilities()` reads the agent's own
 * `initialize` answer. ACP has no steering, so `Turn.steer` always refuses.
 * Approvals arrive as `session/request_permission` and surface as `request`
 * events, answered automatically where the thread's access level decides.
 */

import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { AgentEngineError, RuntimeConnectionError, SteerRejectedError, UnsupportedFeatureError } from "../errors.ts";
import { isTextMedia, localFileSearch, readFileInput } from "../files.ts";
import { seedPreamble } from "../handoff.ts";
import { reviewPrompt } from "../review.ts";
import { TurnHandle, emitTo, inputParts, prefixInput } from "../turn.ts";
import type {
  AgentEvent,
  AgentRequest,
  Availability,
  Capabilities,
  CommandInfo,
  ContextUsage,
  EffectiveConfig,
  Engine,
  EngineEvent,
  FileMatch,
  ForkOptions,
  Goal,
  HistoryTurn,
  LastTurn,
  ListThreadsOptions,
  LoginFlow,
  McpChangeResult,
  McpResourceContent,
  McpServer,
  McpServerState,
  ModelInfo,
  PluginInfo,
  PortableTranscript,
  RealtimeSession,
  ReviewTarget,
  RewindResult,
  TaskInfo,
  Thread,
  ThreadHistory,
  ThreadMode,
  ThreadOptions,
  ThreadSummary,
  TranscriptEntry,
  Turn,
  TurnInput,
  TurnOptions,
  TurnResult,
  UsageReport,
} from "../types.ts";
import { ACP_PROTOCOL_VERSION, AcpClient, AcpRpcError, type SpawnAcpProcess } from "./client.ts";
import { AcpNormalizer } from "./normalize.ts";

type Json = Record<string, any>;

/** ACP agents this library knows how to start. Any other is `{ command, args }`. */
export const ACP_AGENTS = {
  opencode: { name: "OpenCode", command: "opencode", args: ["acp"] },
  gemini: { name: "Gemini CLI", command: "gemini", args: ["--acp"] },
} as const;

/** Engine-wide settings for an ACP agent. */
export interface AcpEngineOptions {
  /** The agent's executable, e.g. `opencode`. */
  command: string;
  /** Arguments that start it in ACP mode, e.g. `["acp"]`. */
  args?: readonly string[];
  /** The agent's name for messages; defaults to the one it reports, else the command. */
  name?: string;
  /** Working directory of the agent process; defaults to the home directory. Threads set their own. */
  cwd?: string;
  /** Environment for the agent; defaults to the current one. */
  env?: Readonly<Record<string, string | undefined>>;
  /** An `agent`-type auth method to use when a session needs sign-in. */
  authMethod?: string;
  /** Requests other than prompts time out after this long. */
  requestTimeoutMs?: number;
  /** Client name the agent records. */
  clientName?: string;
  /** Injectable process factory for tests. */
  spawnProcess?: SpawnAcpProcess;
}

/** The `initialize` answer, as far as this engine reads it. */
interface AcpInit {
  protocolVersion: number;
  agentCapabilities?: Json;
  authMethods?: Json[];
  agentInfo?: { name?: string; title?: string; version?: string };
}

/** Thread MCP servers in ACP's shape. In-process SDK servers cannot cross a process boundary. */
function acpMcpServers(servers: Record<string, McpServer> | undefined, http: boolean): Json[] {
  return Object.entries(servers ?? {}).map(([name, server]) => {
    if (server.type === "sdk") throw new AgentEngineError(`MCP server ${name} is an in-process Claude SDK server; ACP agents need a command or URL.`);
    if (server.type === "http") {
      if (!http) throw new AgentEngineError(`This ACP agent does not take HTTP MCP servers (${name}).`);
      return { type: "http", name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })) };
    }
    if (server.cwd) throw new AgentEngineError(`ACP cannot set a working directory for MCP server ${name}; wrap the command instead.`);
    return { name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })) };
  });
}

/** A config option's choices, flattened out of any groups. */
function optionValues(option: Json | undefined): Array<{ value: string; name: string; description?: string }> {
  const options: Json[] = Array.isArray(option?.options) ? option.options : [];
  return options.flatMap((entry) => (Array.isArray(entry.options) ? entry.options : [entry])).map((entry: Json) => ({
    value: String(entry.value),
    name: String(entry.name ?? entry.value),
    ...(entry.description ? { description: String(entry.description) } : {}),
  }));
}

/** The config option in one category (`model`, `mode`, `thought_level`). */
function optionIn(options: readonly Json[], category: string): Json | undefined {
  return options.find((option) => option?.category === category);
}

/** A mode ID for a neutral mode: one called plan for `plan`; the session's first mode for `default`. */
function modeId(modes: Json | undefined, options: readonly Json[], mode: ThreadMode, initial: string | undefined): string | undefined {
  const candidates = [
    ...(Array.isArray(modes?.availableModes) ? modes.availableModes.map((entry: Json) => ({ id: String(entry.id), name: String(entry.name ?? entry.id) })) : []),
    ...optionValues(optionIn(options, "mode")).map((entry) => ({ id: entry.value, name: entry.name })),
  ];
  if (mode === "plan") return candidates.find((entry) => /plan/iu.test(entry.id) || /plan/iu.test(entry.name))?.id;
  return initial ?? candidates[0]?.id;
}

/** An agent through ACP. */
export class AcpEngine implements Engine {
  readonly provider = "acp" as const;
  private client?: Promise<AcpClient>;
  private init?: AcpInit;
  private readonly threads = new Set<AcpThread>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly seenModes = new Set<ThreadMode>(["default"]);
  private probed?: Promise<{ models: ModelInfo[]; commands: CommandInfo[] }>;
  private closed = false;

  constructor(readonly options: AcpEngineOptions) {
    if (!options?.command) throw new AgentEngineError("An ACP engine needs the agent's command, e.g. { command: \"opencode\", args: [\"acp\"] }.");
  }

  /** The agent's name, for messages. */
  get name(): string {
    return this.options.name ?? this.init?.agentInfo?.title ?? this.init?.agentInfo?.name ?? this.options.command;
  }

  /** @internal The agent's capabilities from `initialize`. */
  get agentCapabilities(): Json {
    return this.init?.agentCapabilities ?? {};
  }

  async availability(): Promise<Availability> {
    try {
      await this.connection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT/u.test(message) || ((error as Error)?.cause as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { provider: "acp", ready: false, reason: "missing-executable", message: `${this.name} is not installed (${this.options.command} was not found).` };
      }
      return { provider: "acp", ready: false, reason: "probe-failed", message: `${this.name} did not start: ${message}` };
    }
    const version = this.init?.agentInfo?.version;
    return { provider: "acp", ready: true, reason: "ready", message: `${this.name} is ready.`, ...(version ? { version } : {}) };
  }

  async capabilities(): Promise<Capabilities> {
    await this.connection();
    const agent = this.agentCapabilities;
    const sessions = record(agent.sessionCapabilities) ?? {};
    const prompt = record(agent.promptCapabilities) ?? {};
    return {
      provider: "acp",
      steer: false,
      compact: false,
      fork: sessions.fork != null,
      rewind: false,
      rewindFiles: false,
      history: sessions.list != null && agent.loadSession === true,
      rename: false,
      archive: false,
      access: ["full", "accept-edits", "ask", "read-only"],
      modes: [...this.seenModes],
      structuredOutput: false,
      contextUsage: true,
      images: prompt.image === true,
      files: prompt.embeddedContext === true ? "content" : "paths",
      goals: false,
      review: "prompt",
      shell: false,
      listTasks: false,
      stopTask: false,
      mcp: { setServers: false, reconnect: false, toggle: false, login: false, readResource: false },
      login: false,
      logout: record(agent.auth)?.logout != null,
      hookEvents: false,
      hookCallbacks: false,
      limits: [],
      handoff: "prompt",
      prewarmThreads: false,
      fileSearch: "local",
      agents: false,
      skills: { reload: false, toggle: false },
      plugins: { list: false, install: false, reload: false },
      config: false,
      realtime: false,
      promptSuggestions: false,
      liveOutput: { commandOutput: false, diff: false, planProposal: false },
    };
  }

  /** The agent's models, read from a session's model option. Opens a session in a temporary folder when no thread is open. */
  async models(): Promise<ModelInfo[]> {
    return (await this.probe()).models;
  }

  async usage(): Promise<UsageReport> {
    return { provider: "acp", checkedAt: new Date(), available: false, windows: [] };
  }

  async commands(_options: { cwd?: string } = {}): Promise<CommandInfo[]> {
    return (await this.probe()).commands;
  }

  async startThread(options: ThreadOptions): Promise<Thread> {
    const thread = new AcpThread(this, options);
    await thread.open();
    this.threads.add(thread);
    return thread;
  }

  async resumeThread(threadId: string, options: ThreadOptions): Promise<Thread> {
    const thread = new AcpThread(this, options, threadId);
    await thread.open();
    this.threads.add(thread);
    return thread;
  }

  async forkThread(threadId: string, options: ForkOptions): Promise<Thread> {
    await this.connection();
    if (record(this.agentCapabilities.sessionCapabilities)?.fork == null) throw new UnsupportedFeatureError("fork sessions", this.name);
    if (options.throughTurnId) throw new UnsupportedFeatureError("fork part of a session", this.name, "ACP forks the whole session");
    const thread = new AcpThread(this, options);
    await thread.open({ forkOf: threadId });
    this.threads.add(thread);
    return thread;
  }

  async deleteThread(threadId: string, _options: { cwd: string }): Promise<void> {
    const client = await this.connection();
    if (record(this.agentCapabilities.sessionCapabilities)?.delete == null) throw new UnsupportedFeatureError("delete sessions", this.name);
    const owner = [...this.threads].find((thread) => thread.id === threadId);
    await owner?.close();
    await client.request("session/delete", { sessionId: threadId }).catch((error: unknown) => {
      if (!(error instanceof AcpRpcError) || error.code !== -32002) throw error;
    });
  }

  async listThreads(options: ListThreadsOptions = {}): Promise<ThreadSummary[]> {
    const client = await this.connection();
    if (record(this.agentCapabilities.sessionCapabilities)?.list == null) throw new UnsupportedFeatureError("list sessions", this.name);
    if (options.archived) return [];
    const limit = options.limit ?? 50;
    const search = options.search?.toLowerCase();
    const threads: ThreadSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20 && threads.length < limit; page += 1) {
      const response: Json = await client.request<Json>("session/list", { ...(options.cwd ? { cwd: options.cwd } : {}), ...(cursor ? { cursor } : {}) });
      for (const session of Array.isArray(response.sessions) ? response.sessions : []) {
        const summary: ThreadSummary = {
          id: String(session.sessionId),
          provider: "acp",
          ...(session.cwd ? { cwd: String(session.cwd) } : {}),
          ...(session.title ? { title: String(session.title) } : {}),
          ...(session.updatedAt ? { updatedAt: new Date(session.updatedAt) } : {}),
        };
        if (!search || summary.title?.toLowerCase().includes(search)) threads.push(summary);
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!cursor) break;
    }
    return threads.slice(0, limit);
  }

  /** Replays a saved session through `session/load` to read its turns. */
  async readThread(threadId: string, options: { cwd: string }): Promise<ThreadHistory> {
    const open = [...this.threads].find((thread) => thread.id === threadId);
    if (open) return { id: threadId, provider: "acp", cwd: options.cwd, ...(open.title ? { title: open.title } : {}), turns: await open.history() };
    await this.connection();
    if (this.agentCapabilities.loadSession !== true) throw new UnsupportedFeatureError("read a saved session back", this.name);
    const thread = new AcpThread(this, { cwd: options.cwd }, threadId);
    try {
      await thread.open({ preferLoad: true });
      return { id: threadId, provider: "acp", cwd: options.cwd, ...(thread.title ? { title: thread.title } : {}), turns: await thread.history() };
    } finally {
      await thread.close();
    }
  }

  async renameThread(): Promise<void> {
    throw new UnsupportedFeatureError("rename sessions", this.name);
  }

  async archiveThread(): Promise<void> {
    throw new UnsupportedFeatureError("archive sessions", this.name);
  }

  async unarchiveThread(): Promise<void> {
    throw new UnsupportedFeatureError("archive sessions", this.name);
  }

  async login(): Promise<LoginFlow> {
    throw new UnsupportedFeatureError("start a sign-in", this.name, `sign in with ${this.options.command} itself`);
  }

  async logout(): Promise<void> {
    const client = await this.connection();
    if (record(this.agentCapabilities.auth)?.logout == null) throw new UnsupportedFeatureError("sign out", this.name);
    await client.request("logout", {});
  }

  async prewarm(): Promise<void> {
    await this.connection();
  }

  async searchFiles(query: string, options: { cwd: string; limit?: number }): Promise<FileMatch[]> {
    return localFileSearch(query, options.cwd, options.limit);
  }

  async config(): Promise<EffectiveConfig> {
    throw new UnsupportedFeatureError("report its settings", this.name);
  }

  async plugins(): Promise<PluginInfo[]> {
    throw new UnsupportedFeatureError("list plugins", this.name);
  }

  async installPlugin(): Promise<void> {
    throw new UnsupportedFeatureError("install plugins", this.name);
  }

  async uninstallPlugin(): Promise<void> {
    throw new UnsupportedFeatureError("uninstall plugins", this.name);
  }

  async setSkillEnabled(): Promise<void> {
    throw new UnsupportedFeatureError("turn skills on or off", this.name);
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const thread of [...this.threads]) await thread.close().catch(() => undefined);
    const client = await this.client?.catch(() => undefined);
    await client?.close();
    this.client = undefined;
  }

  /** @internal */
  forget(thread: AcpThread): void {
    this.threads.delete(thread);
  }

  /** @internal Notes a mode a session offers, for `capabilities().modes`. */
  sawMode(mode: ThreadMode): void {
    this.seenModes.add(mode);
  }

  /** @internal The agent connection, started on first use and again after the agent exits. */
  connection(): Promise<AcpClient> {
    if (this.closed) return Promise.reject(new AgentEngineError(`This ${this.name} engine is closed.`));
    if (!this.client) {
      const connecting = this.connect();
      this.client = connecting;
      connecting.catch(() => {
        if (this.client === connecting) this.client = undefined;
      });
    }
    return this.client;
  }

  /** @internal Signs in with the configured method after the agent said a session needs it. */
  async authenticate(client: AcpClient): Promise<boolean> {
    const method = this.options.authMethod ?? (this.init?.authMethods ?? []).find((entry) => !entry.type || entry.type === "agent")?.id;
    if (!method) return false;
    await client.request("authenticate", { methodId: method }, { timeoutMs: 0 });
    return true;
  }

  private async connect(): Promise<AcpClient> {
    const client = AcpClient.connect({
      command: this.options.command,
      args: this.options.args ?? [],
      cwd: this.options.cwd ?? homedir(),
      env: { ...(this.options.env ?? process.env) } as NodeJS.ProcessEnv,
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
      onRequest: (method, params) => this.agentRequest(method, params),
    });
    client.onNotification((method, params) => {
      if (method !== "session/update") return;
      const sessionId = record(params)?.sessionId;
      for (const thread of this.threads) if (thread.id === sessionId) thread.update(record(record(params)?.update) ?? {});
      for (const pending of this.loading) if (pending.id === sessionId) pending.update(record(record(params)?.update) ?? {});
    });
    client.onClose((error) => {
      this.client = undefined;
      for (const thread of this.threads) thread.lost(error);
    });
    let init: AcpInit;
    try {
      init = await client.request<AcpInit>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {}, url: {} }, session: { notices: {} } },
        clientInfo: { name: this.options.clientName ?? "agent-engines", version: "0.4.0" },
      });
    } catch (error) {
      await client.close();
      throw error;
    }
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      await client.close();
      throw new AgentEngineError(`${this.name} speaks ACP version ${String(init?.protocolVersion)}; this library speaks ${ACP_PROTOCOL_VERSION}.`);
    }
    this.init = init;
    return client;
  }

  /** Threads that are not registered yet but are loading, so replayed updates reach them. */
  private readonly loading = new Set<AcpThread>();

  /** @internal */
  startLoading(thread: AcpThread): () => void {
    this.loading.add(thread);
    return () => this.loading.delete(thread);
  }

  /** Requests the agent sends: permission and elicitation go to their thread; file and terminal requests were not offered. */
  private async agentRequest(method: string, params: unknown): Promise<unknown> {
    const p = record(params) ?? {};
    const thread = [...this.threads, ...this.loading].find((candidate) => candidate.id === p.sessionId) ?? (method === "elicitation/create" ? [...this.threads][0] : undefined);
    if (method === "session/request_permission") {
      if (!thread) return { outcome: { outcome: "cancelled" } };
      return thread.permission(p);
    }
    if (method === "elicitation/create") {
      if (!thread) return { action: "cancel" };
      return thread.elicitation(p);
    }
    throw new AcpRpcError(method, -32601, `${method} is not offered by this client.`);
  }

  /** Models and commands, from an open thread or a session opened in a temporary folder once. */
  private probe(): Promise<{ models: ModelInfo[]; commands: CommandInfo[] }> {
    const open = [...this.threads][0];
    if (open) return Promise.resolve({ models: open.models(), commands: open.commands() });
    if (!this.probed) {
      this.probed = (async () => {
        const thread = new AcpThread(this, { cwd: tmpdir() });
        try {
          await thread.open();
          // Commands arrive just after the session opens.
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { models: thread.models(), commands: thread.commands() };
        } finally {
          await thread.close();
        }
      })();
      this.probed.catch(() => (this.probed = undefined));
    }
    return this.probed;
  }
}

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** How `open` reaches the session. */
interface OpenSource {
  forkOf?: string;
  preferLoad?: boolean;
}

/** One ACP session. */
class AcpThread implements Thread {
  readonly provider = "acp" as const;
  id: string;
  private normalizer: AcpNormalizer;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingRequests = new Set<() => void>();
  private current?: TurnHandle;
  private last?: LastTurn;
  private loadedOn?: AcpClient;
  private modes?: Json;
  private initialMode?: string;
  private replaying = false;
  private closed = false;
  private seedPending: boolean;
  private access: ThreadOptions["access"];

  constructor(
    private readonly engine: AcpEngine,
    private readonly options: ThreadOptions,
    resumeId?: string,
  ) {
    if (!isAbsolute(options.cwd)) throw new AgentEngineError("A thread needs an absolute cwd.");
    if (options.outputSchema) throw new UnsupportedFeatureError("return structured output", engine.name);
    if (options.limits && Object.values(options.limits).some((value) => value !== undefined)) throw new UnsupportedFeatureError("enforce turn limits", engine.name);
    if (options.agents && Object.keys(options.agents).length) throw new UnsupportedFeatureError("take custom subagents", engine.name);
    this.id = resumeId ?? "";
    this.normalizer = new AcpNormalizer(this.id);
    this.seedPending = !resumeId && Boolean(options.seed?.turns.length);
    this.access = options.access;
  }

  get activeTurn(): Turn | undefined {
    return this.current && !this.current.done ? this.current : undefined;
  }

  /** The session's title, when the agent gave one. */
  get title(): string | undefined {
    return this.normalizer.title;
  }

  /** Opens a new session, or resumes, loads or forks a saved one. */
  async open(source: OpenSource = {}): Promise<void> {
    const client = await this.engine.connection();
    const agent = this.engine.agentCapabilities;
    const sessions = record(agent.sessionCapabilities) ?? {};
    const mcpServers = acpMcpServers(this.options.mcpServers, record(agent.mcpCapabilities)?.http === true);
    const extra = this.options.additionalDirectories?.length && sessions.additionalDirectories != null ? { additionalDirectories: this.options.additionalDirectories } : {};
    const params = { cwd: this.options.cwd, mcpServers, ...extra };
    const withAuth = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        // -32000 is ACP's "authentication required".
        if (error instanceof AcpRpcError && error.code === -32000 && (await this.engine.authenticate(client))) return call();
        throw error;
      }
    };
    let response: Json;
    if (source.forkOf) {
      response = await withAuth(() => client.request<Json>("session/fork", { sessionId: source.forkOf, ...params }));
      this.id = String(response.sessionId);
      this.normalizer = new AcpNormalizer(this.id);
    } else if (!this.id) {
      response = await withAuth(() => client.request<Json>("session/new", params));
      this.id = String(response.sessionId);
      this.normalizer = new AcpNormalizer(this.id);
    } else if (agent.loadSession === true && (source.preferLoad || !this.loadedOnce || sessions.resume == null)) {
      // Loading replays the conversation, which is how a resumed thread learns its history; a reload replays it all again.
      if (this.loadedOnce) this.normalizer = new AcpNormalizer(this.id);
      const stop = this.engine.startLoading(this);
      this.replaying = true;
      try {
        response = await withAuth(() => client.request<Json>("session/load", { sessionId: this.id, ...params }, { timeoutMs: 0 }));
      } finally {
        this.replaying = false;
        stop();
      }
      this.normalizer.endReplay();
    } else if (sessions.resume != null) {
      response = await withAuth(() => client.request<Json>("session/resume", { sessionId: this.id, ...params }));
    } else {
      throw new UnsupportedFeatureError("resume sessions", this.engine.name);
    }
    this.loadedOnce = true;
    this.loadedOn = client;
    this.modes = record(response?.modes);
    if (Array.isArray(response?.configOptions)) this.normalizer.configOptions = response.configOptions;
    this.initialMode ??= this.modes?.currentModeId ?? optionIn(this.normalizer.configOptions, "mode")?.currentValue;
    if (modeId(this.modes, this.normalizer.configOptions, "plan", this.initialMode)) this.engine.sawMode("plan");
    if (this.options.model) await this.setOption("model", this.options.model);
    if (this.options.effort) await this.setOption("thought_level", this.options.effort);
    if (this.options.mode) await this.setMode(this.options.mode);
  }

  private loadedOnce = false;

  /** The agent's models, from the session's model option. */
  models(): ModelInfo[] {
    const options = this.normalizer.configOptions;
    const model = optionIn(options, "model");
    const efforts = optionValues(optionIn(options, "thought_level")).map((entry) => entry.value);
    return optionValues(model).map((entry) => ({
      id: entry.value,
      label: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      efforts,
      fastMode: false,
      isDefault: entry.value === model?.currentValue,
    }));
  }

  commands(): CommandInfo[] {
    return this.normalizer.commands;
  }

  run(input: TurnInput, turnOptions: TurnOptions = {}): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; wait for it to end.");
    if (turnOptions.outputSchema) throw new UnsupportedFeatureError("return structured output", this.engine.name);
    const turn = this.newTurn(typeof input === "string" ? input : input.text);
    void (async () => {
      try {
        const client = await this.ready();
        if (turnOptions.model) await this.setOption("model", turnOptions.model);
        if (turnOptions.effort) await this.setOption("thought_level", turnOptions.effort);
        if (turnOptions.mode) await this.setMode(turnOptions.mode);
        if (turnOptions.access) this.access = turnOptions.access;
        const preamble = this.seedPending && this.options.seed ? seedPreamble(this.options.seed) : "";
        this.seedPending = false;
        const prompt = await this.promptBlocks(prefixInput(input, preamble));
        const response = await client.request<Json>("session/prompt", { sessionId: this.id, prompt }, { timeoutMs: 0 });
        this.settle(turn, String(response?.stopReason ?? "end_turn"));
      } catch (error) {
        this.failTurn(turn, error);
      }
    })();
    return turn;
  }

  compact(): Turn {
    throw new UnsupportedFeatureError("compact a session", this.engine.name, "send its /compact command if it lists one in commands()");
  }

  review(target: ReviewTarget): Turn {
    return this.run(reviewPrompt(target));
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subagentTranscript(): Promise<TranscriptEntry[]> {
    throw new UnsupportedFeatureError("report subagents", this.engine.name);
  }

  async lastTurn(): Promise<LastTurn | undefined> {
    if (this.current && !this.current.done) return { turnId: this.current.turnId!, status: "running", text: "" };
    if (this.last) return this.last;
    const turn = this.normalizer.turns[this.normalizer.turns.length - 1];
    if (!turn) return undefined;
    const reply = [...turn.entries].reverse().find((entry) => entry.kind === "message" && entry.role === "assistant");
    return { turnId: turn.id, status: "unknown", text: reply?.kind === "message" ? reply.text : "" };
  }

  async interruptTurn(turnId: string): Promise<void> {
    if (this.current && !this.current.done && this.current.turnId === turnId) await this.current.interrupt();
  }

  async mcpStatus(): Promise<McpServerState[]> {
    return Object.keys(this.options.mcpServers ?? {}).map((name) => ({ name, status: "unknown", tools: [] }));
  }

  async rewind(): Promise<RewindResult> {
    throw new UnsupportedFeatureError("rewind a session", this.engine.name);
  }

  async history(): Promise<HistoryTurn[]> {
    return [...this.normalizer.turns];
  }

  async rename(): Promise<void> {
    throw new UnsupportedFeatureError("rename sessions", this.engine.name);
  }

  async contextUsage(): Promise<ContextUsage> {
    const context = this.normalizer.context;
    if (!context) return { usedTokens: 0 };
    return { usedTokens: context.used, maxTokens: context.size, ...(context.size ? { percent: Math.round((context.used / context.size) * 1000) / 10 } : {}) };
  }

  async setGoal(): Promise<Goal> {
    throw new UnsupportedFeatureError("keep a goal across turns", this.engine.name);
  }

  async goal(): Promise<Goal | undefined> {
    throw new UnsupportedFeatureError("keep a goal across turns", this.engine.name);
  }

  async clearGoal(): Promise<void> {
    throw new UnsupportedFeatureError("keep a goal across turns", this.engine.name);
  }

  async shell(): Promise<void> {
    throw new UnsupportedFeatureError("run a user shell command in a session", this.engine.name);
  }

  async tasks(): Promise<TaskInfo[]> {
    throw new UnsupportedFeatureError("list background tasks", this.engine.name);
  }

  async stopTask(): Promise<void> {
    throw new UnsupportedFeatureError("stop background tasks", this.engine.name);
  }

  async setMcpServers(): Promise<McpChangeResult> {
    throw new UnsupportedFeatureError("change MCP servers in a running session", this.engine.name, "resume the thread with new mcpServers");
  }

  async reconnectMcp(): Promise<void> {
    throw new UnsupportedFeatureError("restart an MCP server", this.engine.name);
  }

  async toggleMcp(): Promise<void> {
    throw new UnsupportedFeatureError("turn an MCP server on or off", this.engine.name);
  }

  async mcpLogin(): Promise<{ url: string }> {
    throw new UnsupportedFeatureError("start an MCP server's sign-in", this.engine.name);
  }

  async readMcpResource(): Promise<McpResourceContent[]> {
    throw new UnsupportedFeatureError("read MCP resources", this.engine.name);
  }

  async reloadSkills(): Promise<CommandInfo[]> {
    throw new UnsupportedFeatureError("reload skills", this.engine.name);
  }

  async reloadPlugins(): Promise<void> {
    throw new UnsupportedFeatureError("reload plugins", this.engine.name);
  }

  async export(): Promise<PortableTranscript> {
    return { provider: "acp", threadId: this.id, turns: await this.history() };
  }

  async realtime(): Promise<RealtimeSession> {
    throw new UnsupportedFeatureError("open a realtime voice session", this.engine.name);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelRequests();
    if (this.current && !this.current.done) this.finish(this.current, { status: "interrupted" });
    this.engine.forget(this);
    const client = this.loadedOn;
    if (client && !client.isClosed && record(this.engine.agentCapabilities.sessionCapabilities)?.close != null) {
      await client.request("session/close", { sessionId: this.id }).catch(() => undefined);
    }
  }

  /** @internal One `session/update` for this session. */
  update(update: Json): void {
    for (const event of this.normalizer.normalize(update, this.replaying)) this.dispatch(event);
  }

  /** @internal The agent connection dropped: fail the running turn and reopen on next use. */
  lost(error: Error): void {
    this.loadedOn = undefined;
    this.cancelRequests();
    if (this.current && !this.current.done) this.failTurn(this.current, error);
  }

  /**
   * @internal A permission request. The access level answers it where it can:
   * `full` allows once, `read-only` refuses once, `accept-edits` allows file edits;
   * anything else surfaces as a `request` event.
   */
  permission(p: Json): Promise<unknown> {
    const options: Json[] = Array.isArray(p.options) ? p.options : [];
    const call = record(p.toolCall) ?? {};
    const pick = (...kinds: string[]) => {
      for (const kind of kinds) {
        const option = options.find((entry) => entry.kind === kind);
        if (option) return { outcome: { outcome: "selected", optionId: String(option.optionId) } };
      }
      return { outcome: { outcome: "cancelled" } };
    };
    const edit = call.kind === "edit" || call.kind === "delete" || call.kind === "move";
    // Automatic answers allow once, so they never widen what the agent may do later.
    if (this.access === "full" || (this.access === "accept-edits" && edit)) return Promise.resolve(pick("allow_once", "allow_always"));
    if (this.access === "read-only") return Promise.resolve(pick("reject_once", "reject_always"));
    return new Promise((resolve) => {
      let settled = false;
      const settle = (answer: unknown) => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(cancel);
        resolve(answer);
      };
      const cancel = () => settle({ outcome: { outcome: "cancelled" } });
      this.pendingRequests.add(cancel);
      const command = call.kind === "execute" ? (record(call.rawInput)?.command ?? call.title) : undefined;
      const request: AgentRequest = {
        kind: "approval",
        id: String(call.toolCallId ?? randomUUID()),
        action: call.kind === "execute" ? "command" : edit ? "file-change" : "tool",
        title: String(call.title ?? "Use a tool"),
        ...(typeof command === "string" ? { command } : Array.isArray(command) ? { command: command.join(" ") } : {}),
        ...(call.name ? { tool: String(call.name) } : {}),
        ...(call.rawInput !== undefined ? { input: call.rawInput } : {}),
        raw: p,
        respond: async ({ decision }) => {
          settle(decision === "allow" ? pick("allow_once", "allow_always")
            : decision === "allow-session" ? pick("allow_always", "allow_once")
            : decision === "deny" ? pick("reject_once", "reject_always")
            : { outcome: { outcome: "cancelled" } });
        },
      };
      this.dispatch({ threadId: this.id, turnId: this.current && !this.current.done ? this.current.turnId! : "", type: "request", request });
    });
  }

  /** @internal An elicitation, surfaced as a `request` event. */
  elicitation(p: Json): Promise<unknown> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (answer: unknown) => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(cancel);
        resolve(answer);
      };
      const cancel = () => settle({ action: "cancel" });
      this.pendingRequests.add(cancel);
      const request: AgentRequest = {
        kind: "elicitation",
        id: String(p.elicitationId ?? randomUUID()),
        server: this.engine.name,
        message: String(p.message ?? ""),
        mode: p.mode === "url" || typeof p.url === "string" ? "url" : "form",
        ...(typeof p.url === "string" ? { url: p.url } : {}),
        ...(p.requestedSchema !== undefined ? { schema: p.requestedSchema } : {}),
        raw: p,
        respond: async ({ action, content }) => settle({ action, ...(content ? { content } : {}) }),
      };
      this.dispatch({ threadId: this.id, turnId: this.current && !this.current.done ? this.current.turnId! : "", type: "request", request });
    });
  }

  private newTurn(prompt: string): TurnHandle {
    const turn: TurnHandle = new TurnHandle(this.id, {
      steer: async () => {
        throw new SteerRejectedError(`${this.engine.name} takes one prompt at a time; wait for the turn to end.`);
      },
      interrupt: async () => {
        if (turn.done || this.current !== turn) return;
        this.loadedOn?.notify("session/cancel", { sessionId: this.id });
        this.cancelRequests();
      },
    });
    turn.setId(randomUUID());
    this.current = turn;
    this.normalizer.startTurn(turn.turnId!, prompt);
    this.dispatch({ threadId: this.id, turnId: turn.turnId!, type: "turn.started" });
    return turn;
  }

  /** The connection, reopening the session if the agent was restarted. */
  private async ready(): Promise<AcpClient> {
    if (this.closed) throw new AgentEngineError("This thread is closed.");
    const client = await this.engine.connection();
    if (this.loadedOn !== client) await this.open();
    return client;
  }

  /** Sets one config option by category (`model`, `thought_level`, `mode`). */
  private async setOption(category: string, value: string): Promise<void> {
    const client = this.loadedOn ?? (await this.engine.connection());
    const option = optionIn(this.normalizer.configOptions, category);
    if (!option) {
      if (category === "model") throw new AgentEngineError(`${this.engine.name} does not let a client choose the model.`);
      return;
    }
    if (option.currentValue === value) return;
    if (!optionValues(option).some((entry) => entry.value === value)) {
      throw new AgentEngineError(`${this.engine.name} does not offer ${category === "thought_level" ? "effort" : category} ${value}.`);
    }
    const response = await client.request<Json>("session/set_config_option", { sessionId: this.id, configId: option.id, value });
    if (Array.isArray(response?.configOptions)) this.normalizer.configOptions = response.configOptions;
  }

  /** Switches to the session mode that matches a neutral mode. */
  private async setMode(mode: ThreadMode): Promise<void> {
    const id = modeId(this.modes, this.normalizer.configOptions, mode, this.initialMode);
    if (!id) throw new UnsupportedFeatureError(`switch to ${mode} mode`, this.engine.name);
    const client = this.loadedOn ?? (await this.engine.connection());
    if (this.modes?.availableModes) {
      await client.request("session/set_mode", { sessionId: this.id, modeId: id });
      this.modes = { ...this.modes, currentModeId: id };
    } else {
      await this.setOption("mode", id);
    }
  }

  /** A turn input as ACP content blocks: text, images, and files embedded or linked. */
  private async promptBlocks(input: TurnInput): Promise<Json[]> {
    const prompt = record(this.engine.agentCapabilities.promptCapabilities) ?? {};
    const { text, images, files } = inputParts(input);
    const blocks: Json[] = [{ type: "text", text }];
    for (const image of images) {
      if (prompt.image !== true) throw new UnsupportedFeatureError("take images", this.engine.name);
      if (image.type === "base64") blocks.push({ type: "image", data: image.data, mimeType: image.mediaType });
      else {
        const read = await readFileInput({ type: "path", path: image.path });
        blocks.push({ type: "image", data: read.data.toString("base64"), mimeType: read.mediaType, uri: `file://${image.path}` });
      }
    }
    for (const file of files) {
      const read = await readFileInput(file);
      const uri = read.path ? `file://${read.path}` : `attachment:${read.name}`;
      if (prompt.embeddedContext === true) {
        blocks.push({
          type: "resource",
          resource: isTextMedia(read.mediaType)
            ? { uri, mimeType: read.mediaType, text: read.data.toString("utf8") }
            : { uri, mimeType: read.mediaType, blob: read.data.toString("base64") },
        });
      } else {
        // Every agent takes a link; it opens the file itself.
        blocks.push({ type: "resource_link", uri, name: read.name, mimeType: read.mediaType, size: read.data.length });
      }
    }
    return blocks;
  }

  /** Ends a turn from its prompt's stop reason. */
  private settle(turn: TurnHandle, stopReason: string): void {
    if (stopReason === "cancelled") return this.finish(turn, { status: "interrupted" });
    if (stopReason === "end_turn") return this.finish(turn, { status: "completed" });
    if (stopReason === "refusal") {
      this.dispatch({ threadId: this.id, turnId: turn.turnId!, type: "notice", kind: "refusal", message: `${this.engine.name} declined this request.` });
      return this.finish(turn, { status: "failed", error: { kind: "other", message: `${this.engine.name} declined this request.` } });
    }
    // max_tokens and max_turn_requests are the agent's own limits.
    this.finish(turn, { status: "failed", error: { kind: "limit", message: `${this.engine.name} stopped: ${stopReason}.` } });
  }

  private finish(turn: TurnHandle, outcome: { status: TurnResult["status"]; error?: TurnResult["error"] }): void {
    if (turn.done) return;
    for (const event of this.normalizer.endTurn(outcome.status === "failed" ? "failed" : outcome.status)) this.dispatch(event);
    const base = { threadId: this.id, turnId: turn.turnId! };
    const text = outcome.status === "failed" ? "" : this.normalizer.reply;
    const event: AgentEvent = outcome.status === "failed"
      ? { ...base, type: "turn.failed", error: outcome.error ?? { kind: "other", message: "The turn failed." } }
      : { ...base, type: "turn.completed", status: outcome.status, text };
    this.dispatch(event);
    this.cancelRequests();
    this.last = { turnId: base.turnId, status: outcome.status, text };
    turn.finish({ ...base, status: outcome.status, text, ...(outcome.error ? { error: outcome.error } : {}) });
  }

  private failTurn(turn: TurnHandle, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof RuntimeConnectionError ? "connection" : error instanceof AcpRpcError && error.code === -32000 ? "auth" : "other";
    this.finish(turn, { status: "failed", error: { kind, message } });
  }

  private dispatch(event: AgentEvent): void {
    const turn = this.current;
    if (turn && !turn.done && event.turnId === turn.turnId) turn.push(event);
    emitTo(this.listeners, event);
  }

  private cancelRequests(): void {
    for (const cancel of [...this.pendingRequests]) cancel();
  }
}

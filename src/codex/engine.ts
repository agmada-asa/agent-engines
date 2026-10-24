/**
 * @file The Codex engine: one `codex app-server` child shared by every thread
 * the engine opens. Threads, turns, steering, interrupts and compaction map to
 * the app-server's own methods; notifications go through `CodexNormalizer`.
 *
 * If the child exits, running turns fail with a `connection` error and the next
 * call starts a fresh child and resumes the thread, so a crash costs one turn.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  AgentEngineError,
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeModelSubstitutionError,
  SteerRejectedError,
  UnsupportedFeatureError,
} from "../errors.ts";
import { CheckpointStore, restoreTree, reverseChanges, snapshotTree } from "../checkpoints.ts";
import { attachedFilesNote, privateTempDir, saveAttachment } from "../files.ts";
import { responsesItems } from "../handoff.ts";
import { TurnHandle, emitTo, inputParts, parseOutput } from "../turn.ts";
import type {
  Access,
  AgentEvent,
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
  McpServerState,
  ModelInfo,
  PluginInfo,
  PortableTranscript,
  RealtimeOptions,
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
  UsageWindow,
} from "../types.ts";
import {
  CodexClient,
  CodexRpcError,
  type CodexLaunchOptions,
  type CodexNotification,
  type SpawnCodexProcess,
} from "./client.ts";
import { CodexNormalizer, codexGoal, codexRequest, codexTool, fileChanges, type PendingCodexRequest } from "./normalize.ts";
import type { FuzzyFileSearchResponse } from "./protocol/FuzzyFileSearchResponse.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { LoginAccountResponse } from "./protocol/v2/LoginAccountResponse.ts";
import type { McpResourceReadResponse } from "./protocol/v2/McpResourceReadResponse.ts";
import type { McpServerOauthLoginResponse } from "./protocol/v2/McpServerOauthLoginResponse.ts";
import type { Model } from "./protocol/v2/Model.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { PluginListResponse } from "./protocol/v2/PluginListResponse.ts";
import type { ReviewStartResponse } from "./protocol/v2/ReviewStartResponse.ts";
import type { Thread as CodexThreadRecord } from "./protocol/v2/Thread.ts";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse.ts";
import type { ThreadForkParams } from "./protocol/v2/ThreadForkParams.ts";
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse.ts";
import type { ThreadGoalGetResponse } from "./protocol/v2/ThreadGoalGetResponse.ts";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse.ts";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.ts";
import type { ThreadSettingsUpdateParams } from "./protocol/v2/ThreadSettingsUpdateParams.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "./protocol/v2/RateLimitWindow.ts";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";

/** The service tier Codex calls fast mode. */
const FAST_TIER = "priority";

/** Environment variables that would make Codex bill an API key instead of the ChatGPT sign-in. */
const API_KEY_VARIABLES = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];

/** What Codex can do through its app-server. */
export const CODEX_CAPABILITIES: Capabilities = {
  provider: "codex",
  steer: true,
  compact: true,
  fork: true,
  rewind: true,
  rewindFiles: true,
  history: true,
  rename: true,
  archive: true,
  access: ["full", "auto", "accept-edits", "ask", "read-only"],
  modes: ["default", "plan"],
  structuredOutput: true,
  contextUsage: true,
  images: true,
  files: "paths",
  goals: true,
  review: "native",
  shell: true,
  listTasks: true,
  stopTask: true,
  mcp: { setServers: false, reconnect: true, toggle: false, login: true, readResource: true },
  login: true,
  logout: true,
  hookEvents: true,
  hookCallbacks: false,
  limits: [],
  handoff: "native",
  prewarmThreads: false,
  fileSearch: "native",
  agents: true,
  skills: { reload: true, toggle: true },
  plugins: { list: true, install: true, reload: false },
  config: true,
  realtime: true,
  promptSuggestions: false,
  liveOutput: { commandOutput: true, diff: true, planProposal: true },
};

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
  /** Absolute working directory of the app-server process; defaults to the home directory. Threads set their own. */
  cwd?: string;
  /** Environment for the app-server and the commands it runs; defaults to the current one. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Codex's home folder (`CODEX_HOME`): its sign-in, config and sessions. Point
   * two engines at two folders to use two accounts side by side.
   */
  home?: string;
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
  if (options.home) env.CODEX_HOME = options.home;
  return env;
}

/** Thread-level approval, sandbox and reviewer settings for an access level. */
function threadAccess(access: Access | undefined): Pick<ThreadStartParams, "approvalPolicy" | "sandbox" | "approvalsReviewer"> {
  switch (access) {
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "auto":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" };
    case "accept-edits":
    case "ask":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "read-only":
      return { approvalPolicy: "never", sandbox: "read-only" };
    default:
      return {};
  }
}

/**
 * Per-turn approval, sandbox and reviewer settings. Sent when the thread sets
 * `codex.networkAccess` (thread start has a sandbox mode but no network flag),
 * and when a turn changed the access level.
 */
function turnPolicy(options: ThreadOptions, access: Access | undefined, changed: boolean): Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy" | "approvalsReviewer"> {
  const networkAccess = options.codex?.networkAccess;
  if (networkAccess === undefined && !changed) return {};
  const settings = threadAccess(access);
  // A turn's own access level wins over the thread's Codex overrides it was started with.
  const approvalPolicy = changed ? settings.approvalPolicy : (options.codex?.approvalPolicy ?? settings.approvalPolicy);
  const sandbox = changed ? settings.sandbox : (options.codex?.sandbox ?? settings.sandbox);
  const sandboxPolicy: SandboxPolicy | undefined =
    sandbox === "read-only" ? { type: "readOnly", networkAccess: networkAccess ?? false }
    : sandbox === "workspace-write" ? { type: "workspaceWrite", writableRoots: options.additionalDirectories ?? [], networkAccess: networkAccess ?? false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    : sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
    : undefined;
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    ...(changed ? { approvalsReviewer: settings.approvalsReviewer ?? "user" } : {}),
  };
}

/** Codex `UserInput` items for a turn. Files are named by path; base64 files are written to a temporary folder first. */
async function codexInput(input: TurnInput, prefix = ""): Promise<UserInput[]> {
  const { text, images, files } = inputParts(input);
  const paths: string[] = [];
  for (const file of files) {
    paths.push(file.type === "path" ? file.path : await saveAttachment(file.name, Buffer.from(file.data, "base64")));
  }
  const items: UserInput[] = [{ type: "text", text: prefix + text + attachedFilesNote(paths), text_elements: [] }];
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

/** A rate limit window's kind, from its length. */
function windowKind(minutes: number | null): UsageWindow["kind"] {
  if (minutes === null) return "other";
  if (minutes <= 24 * 60) return "session";
  if (minutes <= 8 * 24 * 60) return "weekly";
  if (minutes <= 32 * 24 * 60) return "monthly";
  return "other";
}

/** The windows of one rate limit bucket. */
function snapshotWindows(snapshot: RateLimitSnapshot, name: string, model: string | undefined): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const window of [snapshot.primary, snapshot.secondary] as Array<RateLimitWindow | null>) {
    if (!window) continue;
    windows.push({
      kind: windowKind(window.windowDurationMins),
      name,
      ...(model ? { model } : {}),
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === "number" ? { resetsAt: new Date(window.resetsAt * 1000) } : {}),
    });
  }
  return windows;
}

/** `account/rateLimits/read` in the neutral shape. Buckets other than Codex's own name the model they limit. */
export function codexUsage(response: GetAccountRateLimitsResponse, plan: string | undefined, checkedAt = new Date()): UsageReport {
  const buckets = response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId).filter((entry): entry is [string, RateLimitSnapshot] => !!entry[1])
    : [[response.rateLimits.limitId ?? "codex", response.rateLimits] as [string, RateLimitSnapshot]];
  const windows = buckets.flatMap(([id, snapshot]) => {
    const name = snapshot.limitName ?? snapshot.limitId ?? id;
    const model = id === "codex" ? undefined : (snapshot.normalModelSlug ?? snapshot.limitName ?? undefined);
    return snapshotWindows(snapshot, name, model);
  });
  const credits = response.rateLimitResetCredits?.availableCount;
  return {
    provider: "codex",
    checkedAt,
    available: true,
    ...(plan ? { plan } : {}),
    windows,
    ...(credits !== undefined && credits !== null ? { resetCredits: Number(credits) } : {}),
  };
}

/** `skills/list` for one folder as commands; `/compact` is the one command the app-server runs itself. */
export function codexCommands(response: SkillsListResponse | undefined): CommandInfo[] {
  const commands: CommandInfo[] = [{ name: "compact", kind: "command", description: "Compact the conversation's context.", builtin: true }];
  const seen = new Set<string>();
  for (const entry of response?.data ?? []) {
    for (const skill of entry.skills) {
      if (!skill.enabled || seen.has(skill.name)) continue;
      seen.add(skill.name);
      const description = skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
      commands.push({ name: skill.name, kind: "skill", ...(description ? { description } : {}) });
    }
  }
  return commands;
}

/** A Codex thread record as a summary. Codex times are Unix seconds. */
export function codexThreadSummary(thread: CodexThreadRecord, archived?: boolean): ThreadSummary {
  const date = (seconds: number | null | undefined) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : undefined);
  const createdAt = date(thread.createdAt);
  const updatedAt = date(thread.updatedAt);
  const branch = (thread.gitInfo as { branch?: string | null } | null)?.branch;
  return {
    id: thread.id,
    provider: "codex",
    cwd: thread.cwd,
    ...(thread.name ? { title: thread.name } : {}),
    ...(thread.preview ? { preview: thread.preview } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(thread.forkedFromId ? { forkedFrom: thread.forkedFromId } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(branch ? { gitBranch: branch } : {}),
    ...(archived !== undefined ? { archived } : {}),
  };
}

/** A review target in Codex's shape. */
function reviewTarget(target: ReviewTarget): unknown {
  switch (target.type) {
    case "uncommitted":
      return { type: "uncommittedChanges" };
    case "base-branch":
      return { type: "baseBranch", branch: target.branch };
    case "commit":
      return { type: "commit", sha: target.sha, title: target.title ?? null };
    case "custom":
      return { type: "custom", instructions: target.instructions };
  }
}

/**
 * Custom subagents as Codex agent roles: each role is a config file with its
 * model and instructions, named in `agents.<name>` with its description.
 */
async function agentRoles(agents: NonNullable<ThreadOptions["agents"]>): Promise<Record<string, unknown>> {
  const roles: Record<string, unknown> = {};
  const dir = await privateTempDir("codex-agents");
  for (const [name, agent] of Object.entries(agents)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new AgentEngineError(`Agent name ${JSON.stringify(name)} cannot be used safely.`);
    // JSON string escapes are valid TOML basic strings.
    const toml = [
      ...(agent.model ? [`model = ${JSON.stringify(agent.model)}`] : []),
      `developer_instructions = ${JSON.stringify(agent.prompt)}`,
      "",
    ].join("\n");
    const path = join(dir, `${createHash("sha256").update(toml).digest("hex").slice(0, 16)}.toml`);
    await writeFile(path, toml);
    roles[name] = { description: agent.description, config_file: path };
  }
  return roles;
}

/** Codex through `codex app-server`. */
export class CodexEngine implements Engine {
  readonly provider = "codex" as const;
  private client?: Promise<CodexClient>;
  private readonly threads = new Set<CodexThread>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly logins = new Map<string, (outcome: { success: boolean; error?: string }) => void>();
  private verified?: Promise<void>;
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

  async capabilities(): Promise<Capabilities> {
    return structuredClone(CODEX_CAPABILITIES);
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

  async usage(): Promise<UsageReport> {
    const client = await this.connection();
    const account = await client.request<GetAccountResponse>("account/read", {}).catch(() => undefined);
    const plan = account?.account?.type === "chatgpt" ? String(account.account.planType) : undefined;
    if (account?.account && account.account.type !== "chatgpt") return { provider: "codex", checkedAt: new Date(), available: false, windows: [] };
    const limits = await client.request<GetAccountRateLimitsResponse>("account/rateLimits/read", {});
    return codexUsage(limits, plan);
  }

  async commands(options: { cwd?: string } = {}): Promise<CommandInfo[]> {
    const client = await this.connection();
    const cwd = options.cwd ?? this.options.cwd ?? homedir();
    if (!isAbsolute(cwd)) throw new AgentEngineError("commands() needs an absolute cwd.");
    const skills = await client.request<SkillsListResponse>("skills/list", { cwds: [cwd] });
    return codexCommands(skills);
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

  async forkThread(threadId: string, options: ForkOptions): Promise<Thread> {
    const thread = new CodexThread(this, options);
    await thread.open({ fromThreadId: threadId, ...(options.throughTurnId ? { throughTurnId: options.throughTurnId } : {}) });
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

  async listThreads(options: ListThreadsOptions = {}): Promise<ThreadSummary[]> {
    const client = await this.connection();
    const limit = options.limit ?? 50;
    const threads: ThreadSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20 && threads.length < limit; page += 1) {
      const params: ThreadListParams = {
        limit: Math.min(100, limit - threads.length),
        sortKey: "updated_at",
        archived: options.archived ?? false,
        // Subagents are listed under their parent, not as threads of their own.
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.search ? { searchTerm: options.search } : {}),
        ...(cursor ? { cursor } : {}),
      };
      const response: ThreadListResponse = await client.request<ThreadListResponse>("thread/list", params);
      threads.push(...response.data.map((thread) => codexThreadSummary(thread, options.archived ?? false)));
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return threads.slice(0, limit);
  }

  async readThread(threadId: string, _options: { cwd: string }): Promise<ThreadHistory> {
    const client = await this.connection();
    const response = await client.request<ThreadReadResponse>("thread/read", { threadId, includeTurns: false });
    return { ...codexThreadSummary(response.thread), turns: await threadTurns(client, threadId) };
  }

  async renameThread(threadId: string, title: string, _options: { cwd: string }): Promise<void> {
    const client = await this.connection();
    await client.request("thread/name/set", { threadId, name: title });
  }

  async archiveThread(threadId: string, _options: { cwd: string }): Promise<void> {
    const client = await this.connection();
    await client.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string, _options: { cwd: string }): Promise<void> {
    const client = await this.connection();
    await client.request("thread/unarchive", { threadId });
  }

  async login(options: { method?: "browser" | "device-code" } = {}): Promise<LoginFlow> {
    const client = await this.connection({ signedOutOk: true });
    const response = await client.request<LoginAccountResponse>("account/login/start", { type: options.method === "device-code" ? "chatgptDeviceCode" : "chatgpt" });
    if (response.type !== "chatgpt" && response.type !== "chatgptDeviceCode") throw new AgentEngineError(`Codex started an unexpected sign-in: ${response.type}.`);
    const loginId = response.loginId;
    const done = new Promise<{ success: boolean; error?: string }>((resolve) => this.logins.set(loginId, resolve));
    return {
      url: response.type === "chatgpt" ? response.authUrl : response.verificationUrl,
      ...(response.type === "chatgptDeviceCode" ? { code: response.userCode } : {}),
      done,
      cancel: async () => {
        await client.request("account/login/cancel", { loginId }).catch(() => undefined);
        this.logins.get(loginId)?.({ success: false, error: "cancelled" });
        this.logins.delete(loginId);
      },
    };
  }

  async logout(): Promise<void> {
    const client = await this.connection({ signedOutOk: true });
    await client.request("account/logout", undefined);
  }

  async prewarm(_options?: ThreadOptions): Promise<void> {
    await this.connection();
  }

  async searchFiles(query: string, options: { cwd: string; limit?: number }): Promise<FileMatch[]> {
    if (!isAbsolute(options.cwd)) throw new AgentEngineError("searchFiles() needs an absolute cwd.");
    const client = await this.connection();
    const response = await client.request<FuzzyFileSearchResponse>("fuzzyFileSearch", { query, roots: [options.cwd], cancellationToken: null });
    return response.files
      .map((file) => ({ path: file.path, score: file.score, ...(file.indices ? { indices: [...file.indices] } : {}) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 50);
  }

  async config(options: { cwd?: string } = {}): Promise<EffectiveConfig> {
    const client = await this.connection();
    const response = await client.request<ConfigReadResponse>("config/read", { includeLayers: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
    return {
      provider: "codex",
      values: (response.config ?? {}) as Record<string, unknown>,
      ...(response.layers ? {
        sources: [...response.layers].reverse().map((layer) => {
          const source = layer.name as { type: string; file?: string; dotCodexFolder?: string };
          const path = source.file ?? source.dotCodexFolder;
          return { name: source.type, ...(path ? { path } : {}), values: (layer.config ?? {}) as Record<string, unknown> };
        }),
      } : {}),
    };
  }

  async plugins(options: { cwd?: string } = {}): Promise<PluginInfo[]> {
    const client = await this.connection();
    const response = await client.request<PluginListResponse>("plugin/list", options.cwd ? { cwds: [options.cwd] } : {});
    return response.marketplaces.flatMap((marketplace) => marketplace.plugins.map((plugin) => {
      const ui = plugin.interface as { shortDescription?: string | null; displayName?: string | null } | null;
      return {
        id: plugin.id,
        name: ui?.displayName ?? plugin.name,
        ...(ui?.shortDescription ? { description: ui.shortDescription } : {}),
        installed: plugin.installed,
        enabled: plugin.enabled,
        marketplace: marketplace.name,
        ...(plugin.localVersion ?? plugin.version ? { version: (plugin.localVersion ?? plugin.version)! } : {}),
      };
    }));
  }

  async installPlugin(plugin: { name: string; marketplace?: string }): Promise<void> {
    const client = await this.connection();
    await client.request("plugin/install", { pluginName: plugin.name, ...(plugin.marketplace ? { remoteMarketplaceName: plugin.marketplace } : {}) });
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    const client = await this.connection();
    await client.request("plugin/uninstall", { pluginId });
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const client = await this.connection();
    await client.request("skills/config/write", { name, enabled });
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The MCP servers the app-server process loaded, their state and tool names,
   * before any thread starts: for checking a launch (servers disabled, a
   * required server up) without creating a thread. No model call.
   */
  async mcpStatus(): Promise<McpServerState[]> {
    return listMcpServers(await this.connection());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const thread of [...this.threads]) await thread.close().catch(() => undefined);
    const client = await this.client?.catch(() => undefined);
    await client?.close();
    this.client = undefined;
    for (const resolve of this.logins.values()) resolve({ success: false, error: "The engine closed." });
    this.logins.clear();
  }

  /** @internal Forgets a closed thread. */
  forget(thread: CodexThread): void {
    this.threads.delete(thread);
  }

  /**
   * @internal The shared app-server connection, started on first use and again
   * after a crash. `signedOutOk` lets sign-in itself connect without one.
   */
  async connection(options: { signedOutOk?: boolean } = {}): Promise<CodexClient> {
    if (this.closed) throw new AgentEngineError("This Codex engine is closed.");
    if (!this.client) {
      const connecting = this.connect();
      this.client = connecting;
      this.verified = undefined;
      connecting.catch(() => {
        if (this.client === connecting) this.client = undefined;
      });
    }
    const client = await this.client;
    if (!options.signedOutOk && this.options.requireSubscription !== false) await this.verifySubscription(client);
    return client;
  }

  /** Checks once per connection that Codex is signed in on a subscription; sign-in itself may connect without one. */
  private verifySubscription(client: CodexClient): Promise<void> {
    if (!this.verified) {
      const checking = (async () => {
        const account = await client.request<GetAccountResponse>("account/read", {}).catch(() => undefined);
        const state = accountAvailability(account, true);
        if (!state.ready) throw new RuntimeAuthError(state.message, { cause: state });
      })();
      this.verified = checking;
      // A failed check is asked again next time, after the user has signed in.
      checking.catch(() => {
        if (this.verified === checking) this.verified = undefined;
      });
    }
    return this.verified;
  }

  private async connect(): Promise<CodexClient> {
    const client = await CodexClient.connect({
      cwd: this.options.cwd ?? homedir(),
      env: codexEnvironment(this.options),
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.launch ? { launch: this.options.launch } : {}),
      ...(this.options.minimumVersion ? { minimumVersion: this.options.minimumVersion } : {}),
      ...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
      ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
      clientName: this.options.clientName ?? "agent-engines",
      onServerRequest: (request) => this.serverRequest(request),
    });
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
    this.engineEvent(notification);
    const raw = (notification.params as { threadId?: unknown } | undefined)?.threadId;
    const threadId = raw === null ? undefined : raw;
    for (const thread of this.threads) {
      if (threadId === undefined || thread.owns(threadId)) thread.handle(notification);
    }
  }

  /** Account changes and thread-less notices, for `subscribe`. */
  private engineEvent(notification: CodexNotification): void {
    const p = (notification.params ?? {}) as Record<string, any>;
    let event: EngineEvent | undefined;
    switch (notification.method) {
      case "account/updated":
        event = { type: "account.changed", provider: "codex", signedIn: p.authMode != null, ...(p.planType ? { plan: String(p.planType) } : {}) };
        break;
      case "account/login/completed": {
        const resolve = typeof p.loginId === "string" ? this.logins.get(p.loginId) : undefined;
        if (resolve) {
          this.logins.delete(p.loginId);
          resolve({ success: p.success === true, ...(typeof p.error === "string" && p.error ? { error: p.error } : {}) });
        }
        return;
      }
      case "warning":
        if (p.threadId == null && typeof p.message === "string") event = { type: "notice", provider: "codex", kind: "warning", message: p.message, raw: p };
        break;
      case "configWarning":
        event = { type: "notice", provider: "codex", kind: "config", message: String(p.summary ?? ""), ...(p.details ? { details: String(p.details) } : {}), raw: p };
        break;
      case "deprecationNotice":
        event = { type: "notice", provider: "codex", kind: "deprecation", message: String(p.summary ?? ""), ...(p.details ? { details: String(p.details) } : {}), raw: p };
        break;
    }
    if (!event) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A consumer's listener must not break the engine.
      }
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

/** Every turn of a thread with its items, oldest first. */
async function threadTurns(client: CodexClient, threadId: string): Promise<HistoryTurn[]> {
  const turns: HistoryTurn[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const response: ThreadTurnsListResponse = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}),
    });
    for (const turn of response.data) {
      turns.push({
        id: turn.id,
        status: turn.status === "inProgress" ? "running" : turn.status,
        entries: turn.items.flatMap((item) => transcriptEntries(item as Record<string, any>)),
        ...(typeof turn.startedAt === "number" ? { startedAt: new Date(turn.startedAt * 1000) } : {}),
      });
    }
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return turns;
}

/** Every MCP server's state, process-wide or as one thread sees them. */
async function listMcpServers(client: CodexClient, threadId?: string): Promise<McpServerState[]> {
  const servers: McpServerState[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const response: ListMcpServerStatusResponse = await client.request<ListMcpServerStatusResponse>("mcpServerStatus/list", {
      ...(threadId ? { threadId } : {}), detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}),
    });
    for (const server of response.data) {
      servers.push({ name: server.name, status: String((server as { runtimeStatus?: unknown }).runtimeStatus ?? "unknown"), tools: Object.keys(server.tools ?? {}) });
    }
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return servers;
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

/** How `open` reaches the thread: a fork of another, or (by default) start or resume. */
interface OpenSource {
  fromThreadId: string;
  throughTurnId?: string;
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
  /** The model serving the thread, as Codex reported it; plan mode settings name it. */
  private model?: string;
  private access?: Access;
  private accessChanged = false;
  private mode?: ThreadMode;
  /** The mode last sent to Codex on this connection. */
  private appliedMode?: ThreadMode;
  private checkpoints?: Promise<CheckpointStore | undefined>;

  constructor(
    private readonly engine: CodexEngine,
    private readonly options: ThreadOptions,
    resumeId?: string,
  ) {
    if (!isAbsolute(options.cwd)) throw new AgentEngineError("A thread needs an absolute cwd.");
    if (options.limits && Object.values(options.limits).some((value) => value !== undefined)) {
      throw new UnsupportedFeatureError("enforce turn limits", "Codex", "use a goal's token budget, or time the turn in the app");
    }
    this.id = resumeId ?? "";
    this.normalizer = new CodexNormalizer(this.id);
    this.access = options.access;
    this.mode = options.mode;
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

  /** Starts, resumes or forks the thread on the current connection. */
  async open(source?: OpenSource): Promise<void> {
    const client = await this.engine.connection();
    const { options } = this;
    const config: Record<string, unknown> = { ...(options.codex?.config ?? {}) };
    if (options.mcpServers) config.mcp_servers = mcpConfig(options.mcpServers);
    if (options.agents && Object.keys(options.agents).length) config.agents = { ...(config.agents as object | undefined), ...(await agentRoles(options.agents)) };
    if (options.additionalDirectories?.length) {
      const existing = (config.sandbox_workspace_write ?? {}) as Record<string, unknown>;
      config.sandbox_workspace_write = { ...existing, writable_roots: [...((existing.writable_roots as string[] | undefined) ?? []), ...options.additionalDirectories] };
    }
    const shared = {
      ...(options.model ? { model: options.model } : {}),
      cwd: options.cwd,
      ...threadAccess(options.access),
      ...(options.codex?.approvalPolicy ? { approvalPolicy: options.codex.approvalPolicy } : {}),
      ...(options.codex?.sandbox ? { sandbox: options.codex.sandbox } : {}),
      ...(options.codex?.approvalsReviewer ? { approvalsReviewer: options.codex.approvalsReviewer } : {}),
      ...(Object.keys(config).length ? { config: config as ThreadStartParams["config"] } : {}),
      ...(options.instructions ? { developerInstructions: options.instructions } : {}),
      ...(options.codex?.baseInstructions ? { baseInstructions: options.codex.baseInstructions } : {}),
      ...(options.fastMode !== undefined ? { serviceTier: options.fastMode ? FAST_TIER : null } : {}),
    };
    let response: ThreadStartResponse | ThreadForkResponse;
    const fresh = !this.id;
    if (source) {
      const params: ThreadForkParams = {
        threadId: source.fromThreadId,
        ...shared,
        excludeTurns: true,
        ephemeral: options.codex?.ephemeral ?? false,
        ...(source.throughTurnId ? { lastTurnId: source.throughTurnId } : {}),
      };
      response = await client.request<ThreadForkResponse>("thread/fork", params);
      this.id = response.thread.id;
      this.normalizer = new CodexNormalizer(this.id);
    } else if (fresh) {
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
    this.model = response.model;
    this.loadedOn = client;
    this.appliedMode = undefined;
    if (fresh || source) {
      if (options.title) await client.request("thread/name/set", { threadId: this.id, name: options.title });
      if (options.seed && !source) {
        const items = responsesItems(options.seed);
        if (items.length) await client.request("thread/inject_items", { threadId: this.id, items });
      }
    }
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

  review(target: ReviewTarget): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; review after it ends.");
    const turn = this.newTurn();
    void (async () => {
      try {
        const client = await this.ready();
        const tree = await this.snapshot();
        const response = await client.request<ReviewStartResponse>("review/start", { threadId: this.id, target: reviewTarget(target), delivery: "inline" });
        turn.setId(response.turn.id);
        await this.keepSnapshot(response.turn.id, tree);
        if (!this.normalizer.currentTurnId) this.normalizer.currentTurnId = response.turn.id;
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
    return (await threadTurns(client, agentId)).flatMap((turn) => turn.entries);
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

  async interruptTurn(turnId: string): Promise<void> {
    const client = await this.ready();
    await client.request("turn/interrupt", { threadId: this.id, turnId });
  }

  async mcpStatus(): Promise<McpServerState[]> {
    return listMcpServers(await this.ready(), this.id);
  }

  /**
   * Codex rewinds only the conversation, so files are put back here first:
   * from the snapshot taken before `beforeTurnId` when there is one, else by
   * undoing the edits Codex recorded in the dropped turns, newest first.
   */
  async rewind(beforeTurnId: string, options: { files?: boolean } = {}): Promise<RewindResult> {
    if (this.activeTurn) throw new AgentEngineError("A turn is running; rewind after it ends.");
    const client = await this.ready();
    const turns = await threadTurns(client, this.id);
    const index = turns.findIndex((turn) => turn.id === beforeTurnId);
    if (index < 0) throw new AgentEngineError(`No turn ${beforeTurnId} on this thread.`);
    const dropped = turns.slice(index);
    let files: RewindResult["files"];
    if (options.files) {
      const store = await this.checkpointStore();
      const tree = store?.get(beforeTurnId);
      if (tree) {
        files = { ...(await restoreTree(this.options.cwd, tree)), method: "checkpoint" };
      } else {
        const changes = [...dropped].reverse().flatMap((turn) =>
          [...turn.entries].reverse().flatMap((entry) => (entry.kind === "files" ? [...entry.changes].reverse() : [])));
        const reversed = await reverseChanges(changes);
        files = { paths: reversed.paths, method: "edits", ...(reversed.skipped.length ? { skipped: reversed.skipped } : {}) };
      }
    }
    await client.request("thread/revert", { threadId: this.id, beforeTurnId });
    await (await this.checkpointStore())?.forget(dropped.map((turn) => turn.id));
    return { droppedTurns: dropped.length, ...(files ? { files } : {}) };
  }

  /** Where this thread's snapshots are recorded; undefined outside a git repository. */
  private checkpointStore(): Promise<CheckpointStore | undefined> {
    this.checkpoints ??= CheckpointStore.open(this.options.cwd, this.id).catch(() => undefined);
    return this.checkpoints;
  }

  /** With `fileCheckpoints`, a snapshot of the folder before a turn; undefined when there is none to take. */
  private async snapshot(): Promise<string | undefined> {
    if (!this.options.fileCheckpoints || !(await this.checkpointStore())) return undefined;
    return snapshotTree(this.options.cwd).catch(() => undefined);
  }

  /** Records the snapshot taken before `turnId`. */
  private async keepSnapshot(turnId: string, tree: string | undefined): Promise<void> {
    if (tree) await (await this.checkpointStore())?.set(turnId, tree).catch(() => undefined);
  }

  async history(): Promise<HistoryTurn[]> {
    return threadTurns(await this.ready(), this.id);
  }

  async rename(title: string): Promise<void> {
    const client = await this.ready();
    await client.request("thread/name/set", { threadId: this.id, name: title });
  }

  async contextUsage(): Promise<ContextUsage> {
    const context = this.normalizer.context;
    if (!context) return { usedTokens: 0 };
    return {
      usedTokens: context.usedTokens,
      ...(context.maxTokens ? { maxTokens: context.maxTokens, percent: Math.round((context.usedTokens / context.maxTokens) * 1000) / 10 } : {}),
    };
  }

  async setGoal(objective: string, options: { tokenBudget?: number } = {}): Promise<Goal> {
    const client = await this.ready();
    const response = await client.request<{ goal?: unknown }>("thread/goal/set", {
      threadId: this.id, objective, status: "active", origin: "user", ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    });
    return codexGoal(response?.goal as Record<string, unknown> | undefined) ?? { objective, status: "active", ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}) };
  }

  async goal(): Promise<Goal | undefined> {
    const client = await this.ready();
    const response = await client.request<ThreadGoalGetResponse>("thread/goal/get", { threadId: this.id });
    return codexGoal(response.goal as unknown as Record<string, unknown> | undefined);
  }

  async clearGoal(): Promise<void> {
    const client = await this.ready();
    await client.request("thread/goal/clear", { threadId: this.id });
  }

  async shell(command: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const client = await this.ready();
    await client.request("thread/shellCommand", { threadId: this.id, command, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  }

  async tasks(): Promise<TaskInfo[]> {
    const client = await this.ready();
    const response = await client.request<ThreadBackgroundTerminalsListResponse>("thread/backgroundTerminals/list", { threadId: this.id });
    return response.data.map((terminal) => ({ id: terminal.processId, kind: "shell", description: terminal.command, status: "running" as const }));
  }

  async stopTask(taskId: string): Promise<void> {
    const client = await this.ready();
    await client.request("thread/backgroundTerminals/terminate", { threadId: this.id, processId: taskId });
  }

  async setMcpServers(_servers: ThreadOptions["mcpServers"]): Promise<McpChangeResult> {
    throw new UnsupportedFeatureError("replace a running thread's MCP servers", "Codex", "start or resume the thread with new mcpServers");
  }

  async reconnectMcp(_server: string): Promise<void> {
    const client = await this.ready();
    await client.request("config/mcpServer/reload", undefined);
  }

  async toggleMcp(_server: string, _enabled: boolean): Promise<void> {
    throw new UnsupportedFeatureError("turn one MCP server on or off in a running thread", "Codex");
  }

  async mcpLogin(server: string): Promise<{ url: string }> {
    const client = await this.ready();
    const response = await client.request<McpServerOauthLoginResponse>("mcpServer/oauth/login", { name: server, threadId: this.id });
    return { url: response.authorizationUrl };
  }

  async readMcpResource(server: string, uri: string): Promise<McpResourceContent[]> {
    const client = await this.ready();
    const response = await client.request<McpResourceReadResponse>("mcpServer/resource/read", { threadId: this.id, server, uri });
    return response.contents.map((content) => ({
      uri: content.uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      ...("text" in content ? { text: content.text } : { blob: content.blob }),
    }));
  }

  async reloadSkills(): Promise<CommandInfo[]> {
    const client = await this.ready();
    return codexCommands(await client.request<SkillsListResponse>("skills/list", { cwds: [this.options.cwd], forceReload: true }));
  }

  async reloadPlugins(): Promise<void> {
    throw new UnsupportedFeatureError("reload plugins in a running thread", "Codex", "plugins load when a thread starts");
  }

  async export(): Promise<PortableTranscript> {
    return { provider: "codex", threadId: this.id, turns: await this.history() };
  }

  async realtime(options: RealtimeOptions = {}): Promise<RealtimeSession> {
    const client = await this.ready();
    await client.request("thread/realtime/start", {
      threadId: this.id,
      outputModality: options.output ?? "text",
      transport: { type: "websocket" },
      ...(options.model ? { model: options.model } : {}),
      ...(options.instructions ? { prompt: options.instructions } : {}),
    });
    return {
      sendText: async (text, role = "user") => {
        await (await this.ready()).request("thread/realtime/appendText", { threadId: this.id, text, role });
      },
      sendAudio: async (audio) => {
        await (await this.ready()).request("thread/realtime/appendAudio", {
          threadId: this.id,
          audio: { data: audio.data, sampleRate: audio.sampleRate, numChannels: audio.channels, samplesPerChannel: null, itemId: null },
        });
      },
      stop: async () => {
        await (await this.ready()).request("thread/realtime/stop", { threadId: this.id });
      },
    };
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
    const pending = codexRequest(id, method, params, { proposedChanges: this.normalizer.proposedChanges((params as { itemId?: unknown })?.itemId) });
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
      if (turnOptions.access !== undefined && turnOptions.access !== this.access) {
        this.access = turnOptions.access;
        this.accessChanged = true;
      }
      if (turnOptions.mode !== undefined) this.mode = turnOptions.mode;
      if (turnOptions.model) this.model = turnOptions.model;
      const fastMode = turnOptions.fastMode;
      const effort = turnOptions.effort ?? this.options.effort;
      const schema = turnOptions.outputSchema === null ? undefined : (turnOptions.outputSchema ?? this.options.outputSchema);
      turn.expectsOutput = schema !== undefined;
      const params: TurnStartParams = {
        threadId: this.id,
        input: await codexInput(input),
        ...(turnOptions.model ? { model: turnOptions.model } : {}),
        ...(effort ? { effort: effort as TurnStartParams["effort"] } : {}),
        ...(fastMode !== undefined ? { serviceTier: fastMode ? FAST_TIER : null } : {}),
        ...turnPolicy(this.options, this.access, this.accessChanged),
        ...(schema ? { outputSchema: schema as TurnStartParams["outputSchema"] } : {}),
      };
      // Codex takes a mode as a thread setting, not per turn; with no instructions given it uses its own for the mode.
      if (this.mode && this.mode !== this.appliedMode && this.model) {
        const settings: ThreadSettingsUpdateParams = {
          threadId: this.id,
          collaborationMode: { mode: this.mode, settings: { model: this.model, reasoning_effort: (effort ?? null) as TurnStartParams["effort"] & {}, developer_instructions: null } },
        };
        await client.request("thread/settings/update", settings);
        this.appliedMode = this.mode;
      }
      const tree = await this.snapshot();
      const response = await client.request<TurnStartResponse>("turn/start", params);
      turn.setId(response.turn.id);
      await this.keepSnapshot(response.turn.id, tree);
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
      await client.request("turn/steer", { threadId: this.id, input: await codexInput(input), expectedTurnId: turnId });
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
    let delivered = event;
    if (turn && !turn.done && turn.expectsOutput && event.type === "turn.completed" && !event.agentId && event.turnId === turn.turnId) {
      const output = parseOutput(event.text);
      if (output !== undefined) delivered = { ...event, output };
    }
    if (turn && !turn.done && (!turn.turnId || delivered.turnId === turn.turnId || delivered.type === "rate-limit")) {
      turn.push(delivered);
      if (!delivered.agentId && (delivered.type === "turn.completed" || delivered.type === "turn.failed") && delivered.turnId === turn.turnId) {
        this.cancelRequests();
        turn.finish(turnResult(delivered));
      }
    }
    emitTo(this.listeners, delivered);
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
    return {
      threadId: event.threadId,
      turnId: event.turnId,
      status: event.status,
      text: event.text,
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.usage ? { usage: event.usage } : {}),
    };
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
    case "exitedReviewMode":
      return item.review ? [{ kind: "message", role: "assistant", text: item.review }] : [];
    case "reasoning": {
      const text = [...(item.content ?? []), ...(item.content?.length ? [] : item.summary ?? [])].join("\n\n");
      return text ? [{ kind: "reasoning", text }] : [];
    }
    case "fileChange": {
      // Diffs are kept, so a rewind can undo the edits.
      if (item.status !== "completed") return [];
      const changes = fileChanges(item);
      return changes.length ? [{ kind: "files", changes }] : [];
    }
    default: {
      const tool = codexTool(item);
      if (!tool) return [];
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
      return [{ kind: "tool", tool, ...(output ? { output } : {}), ...(item.status === "failed" ? { isError: true } : {}) }];
    }
  }
}

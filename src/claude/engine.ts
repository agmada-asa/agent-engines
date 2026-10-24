/**
 * @file The Claude engine, over the Claude Agent SDK. Each thread is one Claude
 * Code process in streaming-input mode: `run` sends a user message, `steer`
 * sends another while the turn runs, and a `result` message ends the turn. The
 * thread ID is the Claude session ID, chosen here so it is known before the
 * first prompt and can be resumed later in the same `cwd`. Each turn's ID is
 * the UUID of the prompt that started it, so fork and rewind can find it in the
 * transcript.
 *
 * If the process exits, the running turn fails with a `connection` error and the
 * next call starts a new process on the same session. Settings Claude Code only
 * takes at launch (an output schema, the access level) restart the process the
 * same way, keeping the session.
 */

import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFile, readdir, rm, rmdir } from "node:fs/promises";
import * as sdkModule from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpServerConfig,
  OnElicitation,
  Options,
  PermissionMode,
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
  UnsupportedFeatureError,
} from "../errors.ts";
import { checkMinimumVersion } from "../compat.ts";
import { attachedFilesNote, isTextMedia, localFileSearch, mediaTypeOf, readFileInput, saveAttachment } from "../files.ts";
import { seedPreamble } from "../handoff.ts";
import { reviewPrompt } from "../review.ts";
import { TurnHandle, emitTo, inputParts, parseOutput, prefixInput } from "../turn.ts";
import type {
  Access,
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
  UsageWindow,
} from "../types.ts";
import { ClaudeNormalizer, claudeHistory, claudeTranscript, claudeUsage, classifyClaudeError, isPrompt } from "./normalize.ts";

/** Oldest Claude Code this library has been checked against. */
export const CLAUDE_CODE_MIN_VERSION = "2.1.248";

/** Environment variables that would make Claude Code bill an API key instead of the subscription. */
const API_KEY_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/** How long the no-prompt probe waits for Claude Code to initialise. */
const PROBE_TIMEOUT_MS = 30_000;

/** How long a prewarmed thread waits for a `startThread` to claim it before it is closed. */
const SPARE_TTL_MS = 10 * 60_000;

/** Built-in tools that change files or run commands; off in `read-only` access. */
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

/** Image types Claude takes. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** What Claude can do through the Agent SDK. */
export const CLAUDE_CAPABILITIES: Capabilities = {
  provider: "claude",
  steer: true,
  compact: true,
  fork: true,
  rewind: true,
  rewindFiles: true,
  history: true,
  rename: true,
  archive: false,
  access: ["full", "auto", "accept-edits", "ask", "read-only"],
  modes: ["default", "plan"],
  structuredOutput: true,
  contextUsage: true,
  images: true,
  files: "content",
  goals: false,
  review: "prompt",
  shell: false,
  listTasks: true,
  stopTask: true,
  mcp: { setServers: true, reconnect: true, toggle: true, login: false, readResource: true },
  login: false,
  logout: false,
  hookEvents: true,
  hookCallbacks: true,
  limits: ["maxTurns", "maxBudgetUsd", "tokenBudget"],
  handoff: "prompt",
  prewarmThreads: true,
  fileSearch: "local",
  agents: true,
  skills: { reload: true, toggle: false },
  plugins: { list: true, install: false, reload: true },
  config: true,
  realtime: false,
  promptSuggestions: true,
  liveOutput: { commandOutput: false, diff: false, planProposal: true },
};

/** The SDK functions the engine uses; tests inject a fake. */
export type ClaudeSdk = Readonly<Pick<
  typeof sdkModule,
  "query" | "deleteSession" | "getSubagentMessages" | "getSessionInfo" | "getSessionMessages" | "forkSession" | "listSessions" | "renameSession" | "resolveSettings"
>>;

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
  /**
   * Claude's config directory (`CLAUDE_CONFIG_DIR`): its sign-in, settings and
   * sessions. Defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`. Point two engines
   * at two folders to use two accounts side by side.
   */
  configDir?: string;
}

/** Turns a `TurnInput` into SDK message content: images and PDFs as blocks, text files as documents, anything else by path. */
async function claudeContent(input: TurnInput): Promise<SDKUserMessage["message"]["content"]> {
  const { text, images, files } = inputParts(input);
  if (!images.length && !files.length) return text;
  const blocks: Array<Record<string, unknown>> = [];
  for (const image of images) {
    if (image.type === "base64") {
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
      continue;
    }
    const mediaType = mediaTypeOf(image.path);
    if (!IMAGE_TYPES.has(mediaType)) throw new AgentEngineError(`Claude takes PNG, JPEG, WebP or GIF images; ${image.path} is not one.`);
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: (await readFile(image.path)).toString("base64") } });
  }
  const named: string[] = [];
  for (const file of files) {
    const read = await readFileInput(file);
    if (read.mediaType === "application/pdf") {
      blocks.push({ type: "document", title: read.name, source: { type: "base64", media_type: "application/pdf", data: read.data.toString("base64") } });
    } else if (isTextMedia(read.mediaType)) {
      blocks.push({ type: "document", title: read.name, source: { type: "text", media_type: "text/plain", data: read.data.toString("utf8") } });
    } else if (IMAGE_TYPES.has(read.mediaType)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: read.mediaType, data: read.data.toString("base64") } });
    } else {
      named.push(read.path ?? await saveAttachment(read.name, read.data));
    }
  }
  return [{ type: "text", text: text + attachedFilesNote(named) }, ...blocks] as unknown as SDKUserMessage["message"]["content"];
}

/** A user message for the input stream. A prompt's `uuid` is its turn ID. */
function userMessage(content: SDKUserMessage["message"]["content"], options: { priority?: "next"; uuid?: string } = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.uuid ? { uuid: options.uuid } : {}),
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

/** The SDK's `/usage` data, as far as this library reads it. */
interface ClaudeUsageData {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

/** A window from the SDK's usage data, when it has a figure. */
function claudeWindow(value: unknown, kind: UsageWindow["kind"], name: string, model?: string): UsageWindow | undefined {
  const window = value as { utilization?: number | null; resets_at?: string | null } | null | undefined;
  if (typeof window?.utilization !== "number") return undefined;
  const resetsAt = window.resets_at ? new Date(window.resets_at) : undefined;
  return {
    kind,
    name,
    ...(model ? { model } : {}),
    usedPercent: window.utilization,
    ...(resetsAt && !Number.isNaN(resetsAt.getTime()) ? { resetsAt } : {}),
  };
}

/** The SDK's usage data in the neutral shape. */
export function claudeUsageReport(data: ClaudeUsageData | undefined, checkedAt = new Date()): UsageReport {
  const plan = data?.subscription_type ?? undefined;
  const limits = data?.rate_limits;
  if (!data?.rate_limits_available || !limits) return { provider: "claude", checkedAt, available: false, ...(plan ? { plan } : {}), windows: [] };
  const windows = [
    claudeWindow(limits.five_hour, "session", "five_hour"),
    claudeWindow(limits.seven_day, "weekly", "seven_day"),
    claudeWindow(limits.seven_day_opus, "weekly", "seven_day_opus", "Opus"),
    claudeWindow(limits.seven_day_sonnet, "weekly", "seven_day_sonnet", "Sonnet"),
    ...(Array.isArray(limits.model_scoped) ? limits.model_scoped : []).map((scoped: { display_name?: string }) =>
      claudeWindow(scoped, "weekly", `seven_day_${String(scoped.display_name ?? "model").toLowerCase()}`, scoped.display_name),
    ),
  ].filter((window): window is UsageWindow => window !== undefined);
  return { provider: "claude", checkedAt, available: true, ...(plan ? { plan } : {}), windows };
}

/** Claude Code's slash commands (skills included) as commands. */
export function claudeCommands(init: Pick<SDKControlInitializeResponse, "commands">): CommandInfo[] {
  const seen = new Set<string>();
  const commands: CommandInfo[] = [];
  for (const command of init.commands ?? []) {
    if (!command?.name || seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push({
      name: command.name,
      kind: "command",
      ...(command.description ? { description: command.description } : {}),
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      ...((command as { builtin?: boolean }).builtin ? { builtin: true } : {}),
    });
  }
  return commands;
}

/** A session listing in the neutral shape. Claude's times are Unix milliseconds. */
function claudeSummary(info: { sessionId: string; summary?: string; lastModified?: number; customTitle?: string; firstPrompt?: string; gitBranch?: string; cwd?: string; createdAt?: number }): ThreadSummary {
  const title = info.customTitle ?? info.summary;
  return {
    id: info.sessionId,
    provider: "claude",
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(title ? { title } : {}),
    ...(info.firstPrompt ? { preview: info.firstPrompt } : {}),
    ...(info.createdAt ? { createdAt: new Date(info.createdAt) } : {}),
    ...(info.lastModified ? { updatedAt: new Date(info.lastModified) } : {}),
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
  };
}

/**
 * A key that is equal for equal thread options: plain values by content,
 * functions and objects such as in-process MCP servers by identity.
 */
function optionsKey(options: ThreadOptions): string {
  const ids = new WeakMap<object, number>();
  let next = 0;
  const identity = (value: object) => {
    if (!ids.has(value)) ids.set(value, next++);
    return `#${ids.get(value)}`;
  };
  return JSON.stringify(options, (_key, value: unknown) => {
    if (typeof value === "function") return identity(value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return identity(value);
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

/** Claude through the Claude Agent SDK. */
export class ClaudeEngine implements Engine {
  readonly provider = "claude" as const;
  private readonly sdk: ClaudeSdk;
  private readonly threads = new Set<ClaudeThread>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly spares: Array<{ key: string; thread: Promise<ClaudeThread>; timer: ReturnType<typeof setTimeout> }> = [];

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

  async capabilities(): Promise<Capabilities> {
    return structuredClone(CLAUDE_CAPABILITIES);
  }

  async models(): Promise<ModelInfo[]> {
    return (await this.probe()).models.map(claudeModelInfo);
  }

  async usage(): Promise<UsageReport> {
    return this.withProbe(async (query) => {
      const read = (query as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options: { skipBehaviors: boolean }) => Promise<ClaudeUsageData> })
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      // An SDK without the call reports no limits rather than failing.
      if (typeof read !== "function") return claudeUsageReport(undefined);
      return claudeUsageReport(await read.call(query, { skipBehaviors: true }));
    });
  }

  async commands(options: { cwd?: string } = {}): Promise<CommandInfo[]> {
    const cwd = options.cwd ?? tmpdir();
    if (!isAbsolute(cwd)) throw new AgentEngineError("commands() needs an absolute cwd.");
    // Settings load as a thread's would, so the user's, the project's and plugins' commands are listed.
    return claudeCommands(await this.withProbe((query) => query.initializationResult(), { cwd }));
  }

  async startThread(options: ThreadOptions): Promise<Thread> {
    const spare = this.claimSpare(options);
    if (spare) {
      const thread = await spare.catch(() => undefined);
      if (thread && !thread.isClosed) {
        this.threads.add(thread);
        return thread;
      }
    }
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

  async forkThread(threadId: string, options: ForkOptions): Promise<Thread> {
    let upToMessageId: string | undefined;
    if (options.throughTurnId) {
      const messages = await this.sdk.getSessionMessages(threadId, { dir: options.cwd, includeSystemMessages: true });
      upToMessageId = lastEntryOfTurn(messages, options.throughTurnId);
    }
    const forked = await this.sdk.forkSession(threadId, { dir: options.cwd, ...(upToMessageId ? { upToMessageId } : {}), ...(options.title ? { title: options.title } : {}) });
    const thread = new ClaudeThread(this, this.sdk, options, forked.sessionId, true);
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
    const home = this.configHome;
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

  async listThreads(options: ListThreadsOptions = {}): Promise<ThreadSummary[]> {
    // Claude does not archive sessions, so there are no archived ones to list.
    if (options.archived) return [];
    const limit = options.limit ?? 50;
    const search = options.search?.toLowerCase();
    const sessions = await this.sdk.listSessions({ ...(options.cwd ? { dir: options.cwd } : {}), ...(search ? {} : { limit }) });
    return sessions
      .map(claudeSummary)
      .filter((summary) => !search || [summary.title, summary.preview].some((text) => text?.toLowerCase().includes(search)))
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async readThread(threadId: string, options: { cwd: string }): Promise<ThreadHistory> {
    const info = await this.sdk.getSessionInfo(threadId, { dir: options.cwd });
    const messages = await this.sdk.getSessionMessages(threadId, { dir: options.cwd });
    return { ...claudeSummary(info ?? { sessionId: threadId, cwd: options.cwd }), turns: claudeHistory(messages) };
  }

  async renameThread(threadId: string, title: string, options: { cwd: string }): Promise<void> {
    await this.sdk.renameSession(threadId, title, { dir: options.cwd });
  }

  async archiveThread(_threadId: string, _options: { cwd: string }): Promise<void> {
    throw new UnsupportedFeatureError("archive threads", "Claude", "keep an archived flag in the app, or delete the thread");
  }

  async unarchiveThread(_threadId: string, _options: { cwd: string }): Promise<void> {
    throw new UnsupportedFeatureError("archive threads", "Claude");
  }

  async login(): Promise<LoginFlow> {
    throw new UnsupportedFeatureError("start a sign-in", "Claude", "run `claude` and sign in there");
  }

  async logout(): Promise<void> {
    throw new UnsupportedFeatureError("sign out", "Claude", "run `claude` and use /logout");
  }

  /**
   * Without options, checks Claude Code starts and is signed in. With thread
   * options, opens that thread's process now; the next `startThread` with equal
   * options gets it, already initialised. An unclaimed one closes after ten minutes.
   */
  async prewarm(options?: ThreadOptions): Promise<void> {
    if (!options) {
      await this.probe();
      return;
    }
    const thread = new ClaudeThread(this, this.sdk, options, randomUUID(), false);
    const opening = thread.open().then(() => thread);
    const key = optionsKey(options);
    const timer = setTimeout(() => {
      const index = this.spares.findIndex((spare) => spare.thread === opening);
      if (index >= 0) this.spares.splice(index, 1);
      void opening.then((spare) => spare.close(), () => undefined);
    }, SPARE_TTL_MS);
    timer.unref?.();
    this.spares.push({ key, thread: opening, timer });
    await opening;
  }

  async searchFiles(query: string, options: { cwd: string; limit?: number }): Promise<FileMatch[]> {
    return localFileSearch(query, options.cwd, options.limit);
  }

  async config(options: { cwd?: string } = {}): Promise<EffectiveConfig> {
    const resolved = await this.sdk.resolveSettings({ ...(options.cwd ? { cwd: options.cwd } : {}) });
    return {
      provider: "claude",
      values: resolved.effective as Record<string, unknown>,
      sources: resolved.sources.map((source) => ({ name: String(source.source), ...(source.path ? { path: source.path } : {}), values: source.settings as Record<string, unknown> })),
    };
  }

  async plugins(options: { cwd?: string } = {}): Promise<PluginInfo[]> {
    const cwd = options.cwd ?? tmpdir();
    const response = await this.withProbe((query) => query.reloadPlugins(), { cwd });
    return response.plugins.map((plugin) => ({
      id: plugin.name,
      name: plugin.name,
      installed: true,
      enabled: true,
      ...(plugin.source ? { marketplace: plugin.source } : {}),
      ...(plugin.version ? { version: plugin.version } : {}),
    }));
  }

  async installPlugin(_plugin: { name: string; marketplace?: string }): Promise<void> {
    throw new UnsupportedFeatureError("install plugins", "Claude", "run `claude plugin install`, or pass local plugins in claude.plugins");
  }

  async uninstallPlugin(_pluginId: string): Promise<void> {
    throw new UnsupportedFeatureError("uninstall plugins", "Claude", "run `claude plugin uninstall`");
  }

  async setSkillEnabled(_name: string, _enabled: boolean): Promise<void> {
    throw new UnsupportedFeatureError("turn skills on or off", "Claude", "choose a thread's skills with claude.skills");
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const spare of this.spares.splice(0)) {
      clearTimeout(spare.timer);
      await spare.thread.then((thread) => thread.close(), () => undefined);
    }
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

  /** @internal Claude's config folder. */
  get configHome(): string {
    return this.options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  /** @internal The child environment: base plus thread extras, minus API keys when required. */
  environment(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "agent-engines" };
    for (const [key, value] of Object.entries({ ...(this.options.env ?? process.env), ...extra })) {
      if (value !== undefined) env[key] = value;
    }
    if (this.options.configDir) env.CLAUDE_CONFIG_DIR = this.options.configDir;
    if (this.options.requireSubscription !== false) for (const name of API_KEY_VARIABLES) delete env[name];
    return env;
  }

  /** A prewarmed thread opened with these options, taken off the shelf. */
  private claimSpare(options: ThreadOptions): Promise<ClaudeThread> | undefined {
    if (!this.spares.length) return undefined;
    const key = optionsKey(options);
    const index = this.spares.findIndex((spare) => spare.key === key);
    if (index < 0) return undefined;
    const [spare] = this.spares.splice(index, 1);
    clearTimeout(spare!.timer);
    return spare!.thread;
  }

  /** Starts Claude Code without a prompt, reads its init result and stops it. No model is called. */
  private probe(): Promise<SDKControlInitializeResponse> {
    return this.withProbe((query) => query.initializationResult());
  }

  /**
   * Starts Claude Code without a prompt, asks it something and stops it. No
   * model is called and no MCP server starts. With `settings`, the settings files
   * for that folder load as a thread's would; without, none do.
   */
  private async withProbe<T>(use: (query: Query) => Promise<T>, settings?: { cwd: string }): Promise<T> {
    const input = new InputQueue();
    const probe = this.sdk.query({
      prompt: input,
      options: {
        cwd: settings?.cwd ?? tmpdir(),
        env: this.environment(),
        ...(settings ? {} : { settingSources: [], tools: [] }),
        strictMcpConfig: true,
        mcpServers: {},
        persistSession: false,
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        use(probe),
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

type StoredMessage = { type: string; uuid: string; message: unknown; parent_tool_use_id?: string | null };

/** The last stored entry of the turn that began with prompt `turnId`: where a fork that keeps it is cut. */
function lastEntryOfTurn(messages: readonly StoredMessage[], turnId: string): string {
  const start = messages.findIndex((message) => message.uuid === turnId);
  if (start < 0) throw new AgentEngineError(`No turn ${turnId} on this thread.`);
  let last = messages[start]!.uuid;
  for (const message of messages.slice(start + 1)) {
    if (isPrompt(message)) break;
    last = message.uuid;
  }
  return last;
}

/** The permission mode for an access level and mode. */
function permissionModeFor(access: Access | undefined, mode: ThreadMode | undefined): PermissionMode | undefined {
  if (mode === "plan") return "plan";
  switch (access) {
    case "full":
      return "bypassPermissions";
    case "auto":
      return "auto";
    case "accept-edits":
      return "acceptEdits";
    case "ask":
      return "default";
    case "read-only":
      return "dontAsk";
    default:
      return mode === "default" ? "default" : undefined;
  }
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
  private access?: Access;
  private mode?: ThreadMode;
  /** The output schema the running process was started with, as JSON; empty for none. */
  private processSchema = "";
  /** Where the next process resumes the session from, after a rewind. */
  private resumeAt?: { at: string; dropsTurn?: string };
  /** A seed still to put before the first message. */
  private seedPending: boolean;

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
    this.access = options.access;
    this.mode = options.mode;
    this.processSchema = options.outputSchema ? JSON.stringify(options.outputSchema) : "";
    this.seedPending = !resumed && Boolean(options.seed?.turns.length);
  }

  get activeTurn(): Turn | undefined {
    return this.current && !this.current.done ? this.current : undefined;
  }

  /** @internal */
  get isClosed(): boolean {
    return this.closed;
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
        const schema = turnOptions.outputSchema === null ? undefined : (turnOptions.outputSchema ?? this.options.outputSchema);
        const schemaKey = schema ? JSON.stringify(schema) : "";
        const accessChanged = turnOptions.access !== undefined && turnOptions.access !== this.access;
        const modeChanged = turnOptions.mode !== undefined && turnOptions.mode !== this.mode;
        if (turnOptions.access !== undefined) this.access = turnOptions.access;
        if (turnOptions.mode !== undefined) this.mode = turnOptions.mode;
        // Both are launch settings: a new process on the same session picks them up.
        const relaunch = accessChanged || schemaKey !== this.processSchema;
        this.processSchema = schemaKey;
        if (relaunch && this.query) await this.relaunch();
        const query = await this.ready();
        if (modeChanged && !relaunch) {
          const mode = permissionModeFor(this.access, this.mode) ?? "default";
          await query.setPermissionMode(mode);
        }
        if (turnOptions.model) await query.setModel(turnOptions.model);
        const flags: Record<string, unknown> = {};
        if (turnOptions.effort) flags.effortLevel = turnOptions.effort;
        if (turnOptions.fastMode !== undefined) flags.fastMode = turnOptions.fastMode;
        if (Object.keys(flags).length) await query.applyFlagSettings(flags as Parameters<Query["applyFlagSettings"]>[0]);
        turn.expectsOutput = Boolean(schema);
        const preamble = this.seedPending && this.options.seed ? seedPreamble(this.options.seed) : "";
        this.seedPending = false;
        this.send(userMessage(await claudeContent(prefixInput(input, preamble)), { uuid: turn.turnId! }));
      } catch (error) {
        this.failTurn(turn, error);
      }
    })();
    return turn;
  }

  compact(): Turn {
    if (this.activeTurn) throw new AgentEngineError("A turn is already running on this thread; compact after it ends.");
    const turn = this.newTurn();
    void this.ready().then(() => this.send(userMessage("/compact", { uuid: turn.turnId! })), (error) => this.failTurn(turn, error));
    return turn;
  }

  review(target: ReviewTarget): Turn {
    return this.run(reviewPrompt(target));
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

  /**
   * Restores files first (they need the running process and the prompt's
   * checkpoint), then starts a new process that resumes the session from the
   * last entry before `beforeTurnId`.
   */
  async rewind(beforeTurnId: string, options: { files?: boolean } = {}): Promise<RewindResult> {
    if (this.activeTurn) throw new AgentEngineError("A turn is running; rewind after it ends.");
    if (options.files && !this.options.fileCheckpoints) {
      throw new UnsupportedFeatureError("put files back on rewind", "Claude", "start the thread with fileCheckpoints: true");
    }
    const messages = await this.sdk.getSessionMessages(this.id, { dir: this.options.cwd, includeSystemMessages: true });
    const index = messages.findIndex((message) => message.uuid === beforeTurnId);
    if (index < 0 || !isPrompt(messages[index]!)) throw new AgentEngineError(`No turn ${beforeTurnId} on this thread.`);
    const anchor = messages[index - 1]?.uuid;
    if (!anchor) throw new AgentEngineError("There is nothing before the first turn to go back to; start a new thread instead.");
    const later = messages.slice(index).filter(isPrompt);
    let files: RewindResult["files"];
    if (options.files) {
      const result = await (await this.ready()).rewindFiles(beforeTurnId);
      if (!result.canRewind) throw new AgentEngineError(`Claude could not put the files back: ${result.error ?? "no checkpoint for that turn"}.`);
      files = {
        paths: result.filesChanged ?? [],
        ...(result.insertions !== undefined ? { insertions: result.insertions } : {}),
        ...(result.deletions !== undefined ? { deletions: result.deletions } : {}),
      };
    }
    // Claude checks the dropped range is one turn when told which; with several it is left unchecked.
    this.resumeAt = { at: anchor, ...(later.length === 1 ? { dropsTurn: beforeTurnId } : {}) };
    this.last = undefined;
    await this.relaunch();
    return { droppedTurns: later.length, ...(files ? { files } : {}) };
  }

  async history(): Promise<HistoryTurn[]> {
    return claudeHistory(await this.sdk.getSessionMessages(this.id, { dir: this.options.cwd }));
  }

  async rename(title: string): Promise<void> {
    await this.sdk.renameSession(this.id, title, { dir: this.options.cwd });
    this.dispatch({ threadId: this.id, turnId: "", type: "thread.renamed", title });
  }

  async contextUsage(): Promise<ContextUsage> {
    const usage = await (await this.ready()).getContextUsage();
    return {
      usedTokens: usage.totalTokens,
      maxTokens: usage.maxTokens,
      percent: usage.percentage,
      categories: usage.categories.map((category) => ({ name: category.name, tokens: category.tokens, kind: category.kind })),
    };
  }

  async setGoal(_objective: string): Promise<Goal> {
    throw new UnsupportedFeatureError("keep a goal across turns", "Claude", "re-prompt from the app until the work is done");
  }

  async goal(): Promise<Goal | undefined> {
    throw new UnsupportedFeatureError("keep a goal across turns", "Claude");
  }

  async clearGoal(): Promise<void> {
    throw new UnsupportedFeatureError("keep a goal across turns", "Claude");
  }

  async shell(_command: string): Promise<void> {
    throw new UnsupportedFeatureError("run a user shell command in a thread", "Claude", "ask the agent to run it, or run it in the app");
  }

  async tasks(): Promise<TaskInfo[]> {
    return this.normalizer.runningTasks();
  }

  async stopTask(taskId: string): Promise<void> {
    await (await this.ready()).stopTask(taskId);
  }

  async setMcpServers(servers: Record<string, McpServer>): Promise<McpChangeResult> {
    const result = await (await this.ready()).setMcpServers(claudeMcpServers(servers));
    return { added: result.added, removed: result.removed, errors: result.errors };
  }

  async reconnectMcp(server: string): Promise<void> {
    await (await this.ready()).reconnectMcpServer(server);
  }

  async toggleMcp(server: string, enabled: boolean): Promise<void> {
    await (await this.ready()).toggleMcpServer(server, enabled);
  }

  async mcpLogin(_server: string): Promise<{ url: string }> {
    throw new UnsupportedFeatureError("start an MCP server's sign-in", "Claude", "a server that needs one asks through a url elicitation request");
  }

  async readMcpResource(server: string, uri: string): Promise<McpResourceContent[]> {
    const response = await (await this.ready()).readMcpResource(server, uri);
    return response.contents.map((content) => ({
      uri: content.uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.blob !== undefined ? { blob: content.blob } : {}),
    }));
  }

  async reloadSkills(): Promise<CommandInfo[]> {
    const query = await this.ready();
    await query.reloadSkills();
    return claudeCommands({ commands: await query.supportedCommands() });
  }

  async reloadPlugins(): Promise<void> {
    await (await this.ready()).reloadPlugins();
  }

  async export(): Promise<PortableTranscript> {
    return { provider: "claude", threadId: this.id, turns: await this.history() };
  }

  async realtime(): Promise<RealtimeSession> {
    throw new UnsupportedFeatureError("open a realtime voice session", "Claude");
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
        this.send(userMessage(await claudeContent(input), { priority: "next" }));
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

  /** Replaces the process with a new one on the same session, for settings Claude Code takes only at launch. */
  private async relaunch(): Promise<void> {
    const old = this.query;
    this.query = undefined;
    this.input?.end();
    old?.close();
    await this.open();
  }

  private send(message: SDKUserMessage): void {
    if (!this.input) throw new RuntimeConnectionError("The Claude Code process has ended.");
    this.input.push(message);
    this.prompted = true;
    // Once a prompt follows the rewind point, a plain resume carries on from it.
    this.resumeAt = undefined;
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
      const allowed = new Set([this.expectedModel, this.options.model, ...(this.options.fallbackModels ?? [])]);
      if (this.expectedModel && this.options.strictModel !== false && !allowed.has(m.model) && this.current && !this.current.done) {
        this.failTurn(this.current, Object.assign(new AgentEngineError(`Claude Code selected ${m.model}; ${this.options.model} was requested.`), { kind: "model" }));
        void this.query?.interrupt().catch(() => undefined);
      }
      const turn = this.current && !this.current.done ? this.current : undefined;
      for (const event of this.normalizer.normalize(message, turn?.turnId ?? "")) this.dispatch(event);
      return;
    }
    // The agent can start a turn on its own, such as when a background subagent reports back.
    const mainOutput = !m.parent_tool_use_id && !m.agent_id && (m.type === "assistant" || (m.type === "stream_event" && m.event?.type === "message_start"));
    if (mainOutput && (!this.current || this.current.done)) this.newTurn();
    const turn = this.current && !this.current.done ? this.current : undefined;
    for (const event of this.normalizer.normalize(message, turn?.turnId ?? "")) {
      if (event.type === "text.done" && !event.agentId) this.lastText = event.text;
      this.dispatch(event);
      const fallback = event.type === "model.rerouted" && (this.options.fallbackModels ?? []).includes(event.to);
      if (event.type === "model.rerouted" && this.options.strictModel !== false && turn && !fallback) {
        this.failTurn(turn, Object.assign(new AgentEngineError(`Claude switched from ${event.from} to ${event.to}.`), { kind: "model" }));
        void this.query?.interrupt().catch(() => undefined);
      }
    }
    if (m.type === "result" && turn) {
      // A steer Claude could not fold into this turn runs as the next one; the turn covers both.
      if (typeof m.queued_turn_count === "number" && m.queued_turn_count > 0) return;
      const usage = claudeUsage(m.modelUsage);
      if (this.interruptRequested) this.finish(turn, { status: "interrupted", usage });
      else if (m.subtype === "success" && !m.is_error) {
        const text = String(m.result ?? this.lastText);
        const output = m.structured_output !== undefined ? m.structured_output : turn.expectsOutput ? parseOutput(text) : undefined;
        this.finish(turn, { status: "completed", text, usage, ...(output !== undefined ? { output } : {}) });
      } else {
        const detail = m.subtype === "success" ? String(m.result ?? "") : (m.errors ?? []).filter(Boolean).join("; ") || m.subtype;
        // Running out of the thread's own turns or budget is a limit the app set, not a runtime failure.
        const error = m.subtype === "error_max_turns" || m.subtype === "error_max_budget_usd"
          ? { kind: "limit" as const, message: detail }
          : classifyClaudeError(detail, this.normalizer.assistantError, this.normalizer.lastLimit);
        this.finish(turn, { status: "failed", usage, error });
      }
    }
  }

  private finish(turn: TurnHandle, outcome: { status: TurnResult["status"]; text?: string; output?: unknown; usage?: ReturnType<typeof claudeUsage>; error?: TurnResult["error"] }): void {
    if (turn.done) return;
    const base = { threadId: this.id, turnId: turn.turnId! };
    const usage = outcome.usage ? { usage: outcome.usage } : {};
    const output = outcome.output !== undefined ? { output: outcome.output } : {};
    const event: AgentEvent = outcome.status === "failed"
      ? { ...base, type: "turn.failed", error: outcome.error ?? { kind: "other", message: "The Claude turn failed." }, ...usage }
      : { ...base, type: "turn.completed", status: outcome.status, text: outcome.text ?? (outcome.status === "interrupted" ? this.lastText : ""), ...output, ...usage };
    this.dispatch(event);
    this.cancelRequests();
    this.last = { turnId: base.turnId, status: outcome.status, text: event.type === "turn.completed" ? event.text : "" };
    turn.finish({
      ...base,
      status: outcome.status,
      text: event.type === "turn.completed" ? event.text : "",
      ...output,
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
    const access = this.access;
    const settings: Record<string, unknown> = {};
    if (options.fastMode !== undefined) settings.fastMode = options.fastMode;
    // An explicit Claude permission mode wins, except that plan mode is the thread's mode.
    const permissionMode = this.mode === "plan" ? "plan" : (claude.permissionMode ?? permissionModeFor(access, this.mode));
    const disallowed = [...(access === "read-only" ? WRITE_TOOLS : []), ...(claude.disallowedTools ?? [])];
    const limits = options.limits ?? {};
    const schema = this.processSchema ? JSON.parse(this.processSchema) as Record<string, unknown> : undefined;
    const fresh = !this.prompted;
    return {
      cwd: options.cwd,
      env: this.engine.environment(options.env),
      abortController,
      includePartialMessages: true,
      includeHookEvents: true,
      forwardSubagentText: claude.forwardSubagentText ?? true,
      ...(options.progressSummaries ? { agentProgressSummaries: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort as Options["effort"] } : {}),
      systemPrompt: claude.systemPrompt ?? { type: "preset", preset: "claude_code", ...(options.instructions ? { append: options.instructions } : {}) },
      ...(permissionMode ? { permissionMode } : {}),
      // Bypass needs the launch flag even while plan mode is on, so leaving plan mode can return to it.
      ...(access === "full" || permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(options.mcpServers ? { mcpServers: claudeMcpServers(options.mcpServers) } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(claude.settingSources ? { settingSources: claude.settingSources } : {}),
      ...(claude.tools ? { tools: claude.tools } : {}),
      ...(claude.allowedTools ? { allowedTools: claude.allowedTools } : {}),
      ...(disallowed.length ? { disallowedTools: disallowed } : {}),
      ...(claude.strictMcpConfig !== undefined ? { strictMcpConfig: claude.strictMcpConfig } : {}),
      ...(claude.skills !== undefined ? { skills: claude.skills } : {}),
      ...(claude.hooks ? { hooks: claude.hooks as Options["hooks"] } : {}),
      ...(claude.plugins ? { plugins: claude.plugins } : {}),
      ...((claude.executable ?? this.engine.options.executable) ? { pathToClaudeCodeExecutable: claude.executable ?? this.engine.options.executable } : {}),
      ...(schema ? { outputFormat: { type: "json_schema", schema } } : {}),
      ...(limits.maxTurns !== undefined ? { maxTurns: limits.maxTurns } : {}),
      ...(limits.maxBudgetUsd !== undefined ? { maxBudgetUsd: limits.maxBudgetUsd } : {}),
      ...(limits.tokenBudget !== undefined ? { taskBudget: { total: limits.tokenBudget } } : {}),
      ...(options.agents ? { agents: Object.fromEntries(Object.entries(options.agents).map(([name, agent]) => [name, { description: agent.description, prompt: agent.prompt, ...(agent.model ? { model: agent.model } : {}), ...(agent.tools ? { tools: agent.tools } : {}) }])) } : {}),
      ...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
      ...(options.fileCheckpoints ? { enableFileCheckpointing: true } : {}),
      ...(options.fallbackModels?.length ? { fallbackModel: options.fallbackModels.join(",") } : {}),
      ...(options.promptSuggestions ? { promptSuggestions: true } : {}),
      ...(fresh && options.title ? { title: options.title } : {}),
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      // A session exists once a prompt reached Claude; before that, a new process opens it fresh under the same ID.
      ...(this.prompted ? { resume: this.id } : { sessionId: this.id }),
      ...(this.resumeAt ? { resumeSessionAt: this.resumeAt.at, ...(this.resumeAt.dropsTurn ? { resumeDropsTurn: this.resumeAt.dropsTurn } : {}) } : {}),
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
        const planning = toolName === "ExitPlanMode";
        const action = planning ? "plan" : toolName === "Bash" ? "command" : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName) ? "file-change" : "tool";
        request = {
          kind: "approval",
          id,
          action,
          title: planning ? "Approve the plan" : (context.title ?? `Use ${toolName}`),
          tool: toolName,
          input,
          ...(planning && typeof input.plan === "string" ? { plan: input.plan } : {}),
          ...(typeof input.command === "string" ? { command: input.command } : {}),
          ...(context.decisionReason ? { reason: context.decisionReason } : {}),
          raw: { toolName, input, suggestions: context.suggestions },
          respond: async ({ decision, message }) => {
            if (decision === "allow" || decision === "allow-session") {
              // An approved plan ends plan mode; the thread goes back to its access level's mode.
              if (planning) this.mode = "default";
              settle({ behavior: "allow", updatedInput: input, ...(decision === "allow-session" && context.suggestions ? { updatedPermissions: context.suggestions } : {}) });
              if (planning) void this.query?.setPermissionMode(permissionModeFor(this.access, "default") ?? "default").catch(() => undefined);
            } else {
              settle({ behavior: "deny", message: message ?? (planning ? "Keep planning; the user has not approved the plan yet." : "The user declined this."), ...(decision === "cancel" ? { interrupt: true } : {}) });
            }
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

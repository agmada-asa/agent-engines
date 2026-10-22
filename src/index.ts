/**
 * @file agent-engines: one API over Codex (`codex app-server`) and Claude (the
 * Claude Agent SDK). Create an engine, start or resume a thread, run turns and
 * read one normalised event stream. Policy stays with the consumer.
 */

import { ClaudeEngine, type ClaudeEngineOptions } from "./claude/engine.ts";
import { CodexEngine, type CodexEngineOptions } from "./codex/engine.ts";
import type { Engine, ProviderId } from "./types.ts";

/** Options for `createEngine`, by provider. */
export type EngineOptions<P extends ProviderId> = P extends "codex" ? CodexEngineOptions : ClaudeEngineOptions;

/** Creates an engine for one runtime. Nothing starts until it is first used. */
export function createEngine<P extends ProviderId>(provider: P, options?: EngineOptions<P>): Engine {
  if (provider === "codex") return new CodexEngine(options as CodexEngineOptions);
  if (provider === "claude") return new ClaudeEngine(options as ClaudeEngineOptions);
  throw new Error(`Unknown provider ${String(provider)}.`);
}

export type * from "./types.ts";
export { CodexEngine, codexModelInfo, type CodexEngineOptions, type CodexToolCall } from "./codex/engine.ts";
export { ClaudeEngine, CLAUDE_CODE_MIN_VERSION, claudeModelInfo, type ClaudeEngineOptions, type ClaudeSdk } from "./claude/engine.ts";
export {
  CodexClient,
  CodexRpcError,
  appServerArgs,
  type CodexChildProcess,
  type CodexClientOptions,
  type CodexLaunchOptions,
  type CodexNotification,
  type CodexServerRequestHandler,
  type SpawnCodexProcess,
} from "./codex/client.ts";
export { CodexNormalizer, classifyCodexError, codexRequest } from "./codex/normalize.ts";
export { ClaudeNormalizer, classifyClaudeError, claudeUsage } from "./claude/normalize.ts";
export {
  AgentEngineError,
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeModelSubstitutionError,
  RuntimeModelUnavailableError,
  RuntimeProtocolError,
  SteerRejectedError,
} from "./errors.ts";
export {
  CODEX_PROTOCOL_CONTRACT,
  checkMinimumVersion,
  codexProtocolProblems,
  diffModelCatalog,
  hasModelCatalogDrift,
  parseRuntimeVersion,
  readCodexProtocolSurface,
  type ComparableModel,
  type ModelCatalogDrift,
} from "./compat.ts";
export { CODEX_PROTOCOL_VERSION, codexVersionIncompatibility } from "./codex/protocol/version.ts";
export {
  LOCKED_DOWN_CODEX_FEATURES,
  configuredMcpServerNames,
  lockedDownCodexLaunch,
  lockedDownThread,
  minimalEnvironment,
  readConfiguredMcpServerNames,
} from "./presets.ts";

/**
 * @file agent-engines: one API over Codex (`codex app-server`) and Claude (the
 * Claude Agent SDK). Create an engine, start or resume a thread, run turns and
 * read one normalised event stream. Policy stays with the consumer.
 */

import { AcpEngine, type AcpEngineOptions } from "./acp/engine.ts";
import { ClaudeEngine, type ClaudeEngineOptions } from "./claude/engine.ts";
import { CodexEngine, type CodexEngineOptions } from "./codex/engine.ts";
import type { Engine, ProviderId } from "./types.ts";

/** Options for `createEngine`, by provider. */
export type EngineOptions<P extends ProviderId> = P extends "codex" ? CodexEngineOptions : P extends "acp" ? AcpEngineOptions : ClaudeEngineOptions;

/**
 * Creates an engine for one runtime. Nothing starts until it is first used.
 * `acp` needs the agent's command: `createEngine("acp", ACP_AGENTS.opencode)`.
 */
export function createEngine<P extends ProviderId>(provider: P, ...[options]: P extends "acp" ? [options: AcpEngineOptions] : [options?: EngineOptions<P>]): Engine {
  if (provider === "codex") return new CodexEngine(options as CodexEngineOptions);
  if (provider === "claude") return new ClaudeEngine(options as ClaudeEngineOptions);
  if (provider === "acp") return new AcpEngine(options as AcpEngineOptions);
  throw new Error(`Unknown provider ${String(provider)}.`);
}

export type * from "./types.ts";
export {
  CODEX_CAPABILITIES,
  CodexEngine,
  codexCommands,
  codexModelInfo,
  codexThreadSummary,
  codexUsage,
  type CodexEngineOptions,
  type CodexToolCall,
} from "./codex/engine.ts";
export {
  CLAUDE_CAPABILITIES,
  CLAUDE_CODE_MIN_VERSION,
  ClaudeEngine,
  claudeCommands,
  claudeModelInfo,
  claudeUsageReport,
  type ClaudeEngineOptions,
  type ClaudeSdk,
} from "./claude/engine.ts";
export { ACP_AGENTS, AcpEngine, type AcpEngineOptions } from "./acp/engine.ts";
export { ACP_PROTOCOL_VERSION, AcpClient, AcpRpcError, type AcpChildProcess, type AcpClientOptions, type SpawnAcpProcess } from "./acp/client.ts";
export { AcpNormalizer, acpTool } from "./acp/normalize.ts";
export { renderTranscript, responsesItems, seedPreamble } from "./handoff.ts";
export { fuzzyScore, localFileSearch } from "./files.ts";
export { unifiedDiff } from "./diff.ts";
export { reviewPrompt } from "./review.ts";
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
export { CodexNormalizer, classifyCodexError, codexGoal, codexRequest } from "./codex/normalize.ts";
export { ClaudeNormalizer, classifyClaudeError, claudeHistory, claudeUsage } from "./claude/normalize.ts";
export {
  AgentEngineError,
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeModelSubstitutionError,
  RuntimeModelUnavailableError,
  RuntimeProtocolError,
  SteerRejectedError,
  UnsupportedFeatureError,
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

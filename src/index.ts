/**
 * @file agent-engines: one API over Codex (`codex app-server`), Claude (the
 * Claude Agent SDK) and ACP agents. Start or resume a thread, run turns and
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

// The JSON-RPC clients, normalisers, per-runtime mappers and the pieces the
// engines build on are in `agent-engines/internals`, without a stability promise.
export type * from "./types.ts";
export { CODEX_CAPABILITIES, CodexEngine, type CodexEngineOptions, type CodexToolCall, type CodexToolContent, type CodexToolResult } from "./codex/engine.ts";
export { CLAUDE_CAPABILITIES, CLAUDE_CODE_MIN_VERSION, ClaudeEngine, type ClaudeEngineOptions, type ClaudeSdk } from "./claude/engine.ts";
export { ACP_AGENTS, AcpEngine, type AcpEngineOptions } from "./acp/engine.ts";
export { ACP_PROTOCOL_VERSION, AcpRpcError, type AcpChildProcess, type SpawnAcpProcess } from "./acp/client.ts";
export { CodexRpcError, appServerArgs, type CodexChildProcess, type CodexLaunchOptions, type SpawnCodexProcess } from "./codex/client.ts";
export { renderTranscript } from "./handoff.ts";
export { CheckpointStore, gitRepository, snapshotTree } from "./checkpoints.ts";
export { findSharedClaude, runtimeReleaseNotes, runtimeVersion, updateRuntime, type AcpUpdater, type RuntimeTarget } from "./runtime-updates.ts";
export {
  AgentEngineError,
  ConversationRevertError,
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeConnectionError,
  RuntimeModelSubstitutionError,
  RuntimeModelUnavailableError,
  RuntimeProtocolError,
  RuntimeUpdateError,
  SteerRejectedError,
  UnsupportedFeatureError,
  type RuntimeUpdateFailure,
} from "./errors.ts";
export { diffModelCatalog, hasModelCatalogDrift, type ComparableModel, type ModelCatalogDrift } from "./compat.ts";
export { checkMinimumVersion, codexVersionIncompatibility } from "./versions.ts";
export { CODEX_PROTOCOL_VERSION } from "./codex/protocol/version.ts";
export {
  LOCKED_DOWN_CODEX_FEATURES,
  configuredMcpServerNames,
  lockedDownCodexLaunch,
  lockedDownThread,
  minimalEnvironment,
  readConfiguredMcpServerNames,
} from "./presets.ts";

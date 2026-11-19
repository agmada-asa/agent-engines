/**
 * @file `agent-engines/internals`: the pieces the engines are built from, for
 * tools that need to go below the `Engine` API (a custom transport, replaying
 * recorded runtime messages, checking a newer runtime's protocol).
 *
 * These follow the runtimes' own formats closely, so they can change in any
 * minor release. Everything an app needs is in the main entry point.
 */

export { AcpClient, type AcpClientOptions } from "./acp/client.ts";
export { AcpNormalizer, acpTool } from "./acp/normalize.ts";
export { CodexClient, type CodexClientOptions, type CodexNotification, type CodexServerRequestHandler } from "./codex/client.ts";
export { CodexNormalizer, classifyCodexError, codexGoal, codexRequest } from "./codex/normalize.ts";
export { codexCommands, codexModelInfo, codexThreadSummary, codexUsage } from "./codex/engine.ts";
export { ClaudeNormalizer, classifyClaudeError, claudeHistory, claudeUsage } from "./claude/normalize.ts";
export { claudeCommands, claudeModelInfo, claudeUsageReport } from "./claude/engine.ts";
export { responsesItems, seedPreamble } from "./handoff.ts";
export { fuzzyScore, localFileSearch } from "./files.ts";
export { unifiedDiff } from "./diff.ts";
export { restoreTree, reverseChanges, reverseDiff } from "./checkpoints.ts";
export { reviewPrompt } from "./review.ts";
export { CODEX_PROTOCOL_CONTRACT, codexProtocolProblems, readCodexProtocolSurface, type CodexProtocolSurface } from "./compat.ts";
export { parseRuntimeVersion } from "./versions.ts";

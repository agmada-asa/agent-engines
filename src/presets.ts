/**
 * @file Ready-made restrictive settings for
 * consumers that run agents on untrusted input. Nothing applies them by
 * default; spread them into engine or thread options where wanted.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexLaunchOptions } from "./codex/client.ts";
import type { ThreadOptions } from "./types.ts";

/**
 * Codex features switched off for unattended job children. `code_mode_host`
 * stays on: Codex routes host tool calls through it.
 */
export const LOCKED_DOWN_CODEX_FEATURES = [
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "code_mode",
  "workspace_dependencies",
  "hooks",
  "skill_search",
  "skill_mcp_dependency_install",
  "image_generation",
  "view_image",
  "daemon_auto_start",
  "multi_agent",
] as const;

/**
 * Codex launch flags with every feature above off and, optionally, the
 * operator's configured MCP servers disabled (see `readConfiguredMcpServerNames`).
 * Plugin-provided servers cannot be disabled this way; `plugins` being off covers them.
 */
export function lockedDownCodexLaunch(options: { keepFeatures?: readonly string[]; disableMcpServers?: readonly string[] } = {}): CodexLaunchOptions {
  const keep = new Set(options.keepFeatures ?? []);
  const config: Record<string, unknown> = {};
  for (const name of options.disableMcpServers ?? []) config[`mcp_servers.${name}.enabled`] = false;
  return { disabledFeatures: LOCKED_DOWN_CODEX_FEATURES.filter((feature) => !keep.has(feature)), config };
}

/**
 * Thread settings that load nothing from the operator's own config, allow no
 * built-in tools unless listed, never ask and never write. Pass the thread's
 * own tools through `mcpServers` and `claude.allowedTools`.
 */
export function lockedDownThread(options: { builtInTools?: string[]; webSearch?: boolean } = {}): Partial<ThreadOptions> {
  const builtIn = options.builtInTools ?? (options.webSearch ? ["WebSearch", "WebFetch"] : []);
  return {
    access: "read-only",
    codex: {
      approvalPolicy: "never",
      sandbox: "read-only",
      networkAccess: false,
      config: { web_search: options.webSearch ? "live" : "disabled" },
    },
    claude: {
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      tools: builtIn,
      allowedTools: builtIn,
      permissionMode: "dontAsk",
      extra: { permissionPrompts: "none" },
    },
  };
}

/** OS launch variables only: no app secrets reach the agent. Add the runtime's own home if needed. */
export function minimalEnvironment(source: NodeJS.ProcessEnv = process.env, extra: readonly string[] = []): Record<string, string> {
  const allowed = new Set(["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", ...extra]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  return env;
}

/** MCP server names defined as `[mcp_servers.<name>]` tables in a Codex `config.toml`. */
export function configuredMcpServerNames(configToml: string): string[] {
  const names = new Set<string>();
  for (const match of configToml.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))/gmu)) names.add(match[1] ?? match[2]);
  return [...names];
}

/** Reads MCP server names from `$CODEX_HOME/config.toml`; a missing file means none. */
export async function readConfiguredMcpServerNames(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  try {
    return configuredMcpServerNames(await readFile(join(codexHome, "config.toml"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

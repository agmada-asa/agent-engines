# Thread options

What `startThread`, `resumeThread` and `forkThread` take, and what each option becomes on each runtime.

| Option | Codex | Claude | ACP |
| --- | --- | --- | --- |
| `cwd` | Thread cwd | Process cwd | Session cwd |
| `model`, `effort` | Thread and per-turn | SDK options and per-turn controls | The session's `model` and `thought_level` options |
| `fastMode` | `priority` service tier, thread and per-turn | Fast mode setting, and per-turn controls | Ignored |
| `serviceTier` | Catalogue tier ID, or `null` for the runtime default; overrides `fastMode`, thread and per-turn | Not supported | Not supported |
| `access` | Approval policy, sandbox and reviewer | Permission mode | Answers permission requests itself where it can |
| `mode` (`default`, `plan`) | The thread's collaboration mode, set before the turn | Plan permission mode | The session mode named plan |
| `instructions` | Developer instructions | Appended to Claude Code's system prompt | Not sent |
| `mcpServers` | Per-thread `mcp_servers` config | SDK `mcpServers` (also in-process `sdk` servers, and `alwaysLoad`) | `session/new` servers |
| `env` | Engine-wide only (`CodexEngineOptions.env`) | Per thread | Engine-wide only |
| `strictModel` | Fails a silent model swap | Same | |
| `title` | `thread/name/set` | SDK `title` | Ignored |
| `outputSchema` | Per-turn `outputSchema` | `outputFormat` | Not supported |
| `limits` | Not supported | `maxTurns`, `maxBudgetUsd`, task budget | Not supported |
| `agents` | Agent roles (`agents.<name>` config with a role file) | SDK `agents` | Not supported |
| `additionalDirectories` | Workspace sandbox writable roots | SDK `additionalDirectories` | Sent when the agent takes them |
| `fileCheckpoints` | A git snapshot of the folder before each turn, for `rewind({ files: true })` | File checkpointing, for `rewind({ files: true })` | Ignored |
| `seed` | Injected as history | Put before the first message | Put before the first message |
| `fallbackModels`, `promptSuggestions`, `progressSummaries` | Ignored | SDK `fallbackModel`, `promptSuggestions`, `agentProgressSummaries` | Ignored |

"Not supported" options throw `UnsupportedFeatureError` when set, rather than being dropped.

## Access levels

`access` is one of:

| Level | Meaning |
| --- | --- |
| `full` | No approvals |
| `auto` | The runtime's own reviewer decides routine approvals. Not on ACP. |
| `accept-edits` | Edits go ahead. On Codex this is the same as `ask`, since the workspace sandbox already allows them. |
| `ask` | The agent asks |
| `read-only` | No changes |

`capabilities().access` lists the levels a runtime has a native setting for.

## Runtime-specific options

Anything specific to one runtime goes in `codex: {…}` or `claude: {…}`.

**`codex`**

- Approval policy, approvals reviewer and sandbox
- Network, also reasserted with the sandbox and approval policy on every turn
- `baseInstructions`, which replaces Codex's base instructions entirely
- `config` overrides
- Host-answered `dynamicTools`
- Ephemeral threads
- [`listMcpTools`](/guide/agent-features#telling-a-codex-thread-its-tool-names)

**`claude`**

- Setting sources, built-in tools, and allowed and disallowed tools
- Permission mode, skills and system prompt
- `executable`, the Claude Code binary to run
- `strictMcpConfig`, which loads only `mcpServers` and ignores servers from settings and plugins
- `forwardSubagentText`, which forwards subagents' text and thinking as well as their tool calls (on by default)
- Host `hooks` and local `plugins`
- `extra` for any other SDK option

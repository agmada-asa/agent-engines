/** @file Runtime versions and updates: who owns a binary, what is offered, and how an update ends. Everything runs on a fake machine unless it says otherwise. */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { AcpEngine } from "../src/acp/engine.ts";
import { ClaudeEngine } from "../src/claude/engine.ts";
import { CodexEngine } from "../src/codex/engine.ts";
import { RuntimeUpdateError, UnsupportedFeatureError, type RuntimeUpdateFailure } from "../src/errors.ts";
import { runtimeVersion, updateRuntime } from "../src/runtime-updates.ts";
import type { BundledClaude, RuntimeExecResult, RuntimeHost } from "../src/types.ts";
import { fakeAcpSpawner } from "./fake-acp-agent.ts";
import { fakeClaudeSdk } from "./fake-claude-sdk.ts";

const NPM_CODEX = "https://registry.npmjs.org/@openai/codex/latest";
const NPM_CLAUDE = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const NPM_SDK = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest";

/** What the registries answer unless a test says otherwise. */
const PUBLISHED: Record<string, unknown> = {
  [NPM_CODEX]: { version: "0.166.0" },
  [NPM_CLAUDE]: { version: "2.1.316" },
  [NPM_SDK]: { version: "0.3.316", claudeCodeVersion: "2.1.316" },
};

interface FakeMachine {
  /** Files that can be run. */
  executables?: string[];
  /** Symlinks, as path to the file they lead to. */
  links?: Record<string, string>;
  /** Scripts `readText` can read. */
  texts?: Record<string, string>;
  /** PATH for the check. */
  path?: string;
  /** What `--version` prints; undefined makes it fail. */
  version?: string;
  /** Runs the installer: return what it reports, and set `machine.version` to change the binary. */
  install?: (machine: FakeMachine, argv: readonly string[]) => Partial<RuntimeExecResult> | void;
  /** Registry answers by URL; an Error fails the lookup. Merged over `PUBLISHED`. */
  documents?: Record<string, unknown>;
  /** Every lookup fails, as when offline. */
  offline?: boolean;
  bundled?: BundledClaude;
  platform?: NodeJS.Platform;
}

/** Builds a fake host, and records every command and lookup it is asked for. */
function fake(machine: FakeMachine) {
  const ran: Array<{ argv: string[]; env: Readonly<Record<string, string | undefined>>; cwd?: string }> = [];
  const looked: Array<{ url: string; headers: Record<string, string> }> = [];
  const host: Partial<RuntimeHost> = {
    platform: machine.platform ?? "darwin",
    exec: async (command, args, options) => {
      const argv = [command, ...args];
      if (args[0] === "--version") {
        return machine.version === undefined
          ? { exitCode: 1, stdout: "", stderr: "stub: the native binary is missing" }
          : { exitCode: 0, stdout: `${machine.version}\n`, stderr: "" };
      }
      ran.push({ argv, env: options.env, cwd: options.cwd });
      return { exitCode: 0, stdout: "installed\n", stderr: "", ...machine.install?.(machine, argv) };
    },
    fetch: async (url, init) => {
      looked.push({ url, headers: init.headers });
      if (machine.offline) throw new TypeError("fetch failed");
      const document = { ...PUBLISHED, ...machine.documents }[url];
      if (document instanceof Error) throw document;
      return { ok: document !== undefined, json: async () => document };
    },
    realpath: async (path) => machine.links?.[path] ?? path,
    isExecutable: async (path) => (machine.executables ?? []).includes(path),
    readText: async (path) => machine.texts?.[path],
    bundledClaude: async () => machine.bundled,
  };
  return { host, ran, looked, env: { PATH: machine.path ?? "/usr/bin" } };
}

/** The error an update fails with, checked for its reason. */
async function failure(update: Promise<unknown>, reason: RuntimeUpdateFailure): Promise<RuntimeUpdateError> {
  const error = await update.then(() => undefined, (rejection: unknown) => rejection);
  assert.ok(error instanceof RuntimeUpdateError, `expected a RuntimeUpdateError, got ${String(error)}`);
  assert.equal(error.reason, reason);
  return error;
}

// Who owns the binary

const NVM = "/home/me/.nvm/versions/node/v24.1.0";

/** Codex as an npm global under a Node version manager, with its own npm. */
function npmCodex(extra: Partial<FakeMachine> = {}): FakeMachine {
  return {
    path: `${NVM}/bin:/usr/bin`,
    executables: [`${NVM}/bin/codex`, `${NVM}/bin/npm`],
    links: { [`${NVM}/bin/codex`]: `${NVM}/lib/node_modules/@openai/codex/bin/codex.js` },
    version: "codex-cli 0.164.0",
    ...extra,
  };
}

test("an npm global: symlink followed, its own npm, its prefix pinned and its bin first on PATH", async () => {
  const { host, ran, env } = fake(npmCodex({ install: (machine) => void (machine.version = "codex-cli 0.166.0") }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.provider, "codex");
  assert.equal(status.installed, true);
  assert.equal(status.version, "0.164.0");
  assert.equal(status.latest, "0.166.0");
  assert.equal(status.path, `${NVM}/lib/node_modules/@openai/codex/bin/codex.js`);
  assert.equal(status.managedBy, "npm");
  assert.equal(status.compatible, true);
  assert.equal(status.latestCompatible, true);
  assert.equal(status.newerAvailable, true);
  assert.equal(status.canUpdate, true);
  assert.equal(status.canPinVersion, true);
  assert.equal(status.updateOffered, true);
  assert.equal(status.reason, undefined);
  assert.equal(ran.length, 0, "a status check installs nothing");

  const result = await updateRuntime("codex", { host, env });
  assert.deepEqual({ outcome: result.outcome, from: result.from, to: result.to, managedBy: result.managedBy }, { outcome: "updated", from: "0.164.0", to: "0.166.0", managedBy: "npm" });
  assert.deepEqual(ran.length, 1);
  assert.deepEqual(ran[0].argv, [`${NVM}/bin/npm`, "install", "--global", "--prefix", NVM, "--no-fund", "--no-audit", "--no-update-notifier", "@openai/codex@0.166.0"]);
  assert.deepEqual(result.command, ran[0].argv);
  assert.equal(ran[0].env.PATH?.split(":")[0], `${NVM}/bin`);
  assert.notEqual(ran[0].cwd, undefined, "installers run outside the app's folder, away from its package.json");
});

test("an npm global under a prefix with no npm: the npm on PATH, with --prefix so it cannot land in that npm's own prefix", async () => {
  const brew = "/opt/homebrew";
  const { host, ran, env } = fake({
    path: `${NVM}/bin:${brew}/bin`,
    executables: [`${NVM}/bin/npm`, `${brew}/bin/claude`],
    links: { [`${brew}/bin/claude`]: `${brew}/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` },
    version: "2.1.310 (Claude Code)",
    install: (machine) => void (machine.version = "2.1.316 (Claude Code)"),
  });
  const target = { executable: `${brew}/bin/claude`, host, env };
  const status = await runtimeVersion("claude", target);
  assert.equal(status.managedBy, "npm", "under the Homebrew prefix, but npm owns it");
  assert.deepEqual(status.updateCommand, [`${NVM}/bin/npm`, "install", "--global", "--prefix", brew, "--no-fund", "--no-audit", "--no-update-notifier", "--allow-scripts=@anthropic-ai/claude-code", "@anthropic-ai/claude-code@2.1.316"]);
  const result = await updateRuntime("claude", target);
  assert.equal(result.to, "2.1.316");
  assert.deepEqual(ran[0].argv, status.updateCommand);
  assert.equal(ran[0].env.PATH?.split(":")[0], `${brew}/bin`);
});

test("the owner's npm beats one earlier on PATH", async () => {
  const other = "/usr/local";
  const { host, env } = fake(npmCodex({ path: `${other}/bin:${NVM}/bin`, executables: [`${other}/bin/npm`, `${NVM}/bin/npm`, `${NVM}/bin/codex`] }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.updateCommand?.[0], `${NVM}/bin/npm`);
});

test("an npm global with no npm anywhere is reported, not guessed at", async () => {
  const { host, env } = fake(npmCodex({ executables: [`${NVM}/bin/codex`] }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.managedBy, "npm");
  assert.equal(status.canUpdate, false);
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /npm was not found/);
  await failure(updateRuntime("codex", { host, env }), "not-updatable");
});

test("a pnpm global before pnpm 11: a script in the home, naming its target", async () => {
  const home = "/home/me/.local/share/pnpm";
  const { host, ran, env } = fake({
    path: `${home}:/usr/bin`,
    executables: [`${home}/codex`, `${home}/pnpm`],
    texts: { [`${home}/codex`]: `#!/bin/sh\nexec node "$basedir/global/5/node_modules/@openai/codex/bin/codex.js" "$@"\n` },
    version: "codex-cli 0.164.0",
    install: (machine) => void (machine.version = "codex-cli 0.166.0"),
  });
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.managedBy, "pnpm");
  assert.equal(status.path, `${home}/codex`);
  await updateRuntime("codex", { host, env });
  assert.deepEqual(ran[0].argv, [`${home}/pnpm`, "add", "--global", "@openai/codex@0.166.0"]);
  assert.equal(ran[0].env.PNPM_HOME, home);
  assert.deepEqual(ran[0].env.PATH?.split(":").slice(0, 2), [`${home}/bin`, home]);
});

test("a pnpm global from pnpm 11: the script sits in <home>/bin and points up", async () => {
  const home = "/home/me/Library/pnpm";
  const { host, ran, env } = fake({
    path: `${home}/bin:/opt/tools/bin`,
    executables: [`${home}/bin/claude`, "/opt/tools/bin/pnpm"],
    texts: { [`${home}/bin/claude`]: `#!/bin/sh\nexec node "$basedir_abs/../global/v11/abc123/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n` },
    version: "2.1.310 (Claude Code)",
    install: (machine) => void (machine.version = "2.1.316 (Claude Code)"),
  });
  const target = { executable: "claude", host, env };
  assert.equal((await runtimeVersion("claude", target)).managedBy, "pnpm");
  await updateRuntime("claude", target);
  assert.deepEqual(ran[0].argv, ["/opt/tools/bin/pnpm", "add", "--global", "--allow-build=@anthropic-ai/claude-code", "@anthropic-ai/claude-code@2.1.316"]);
  assert.equal(ran[0].env.PNPM_HOME, home);
});

test("a pnpm global reached directly, without its script", async () => {
  const home = "/home/me/.local/share/pnpm";
  const binary = `${home}/global/5/.pnpm/@openai+codex@0.164.0/node_modules/@openai/codex/bin/codex.js`;
  const { host, ran, env } = fake({
    executables: [binary, `${home}/pnpm`],
    version: "codex-cli 0.164.0",
    install: (machine) => void (machine.version = "codex-cli 0.166.0"),
  });
  await updateRuntime("codex", { executable: binary, host, env });
  assert.equal(ran[0].env.PNPM_HOME, home);
});

test("a project's own pnpm install is not a pnpm global", async () => {
  const binary = "/work/app/node_modules/.pnpm/@openai+codex@0.164.0/node_modules/@openai/codex/bin/codex.js";
  const { host, env } = fake({ executables: [binary], version: "codex-cli 0.164.0" });
  const status = await runtimeVersion("codex", { executable: binary, host, env });
  assert.equal(status.managedBy, "unknown");
  assert.match(status.reason ?? "", /project dependency/);
});

test("a bun global: its own bun when it has one, BUN_INSTALL pinned", async () => {
  const root = "/home/me/.bun";
  const { host, ran, env } = fake({
    path: `${root}/bin:/usr/bin`,
    executables: [`${root}/bin/codex`, `${root}/bin/bun`],
    links: { [`${root}/bin/codex`]: `${root}/install/global/node_modules/@openai/codex/bin/codex.js` },
    version: "codex-cli 0.164.0",
    install: (machine) => void (machine.version = "codex-cli 0.166.0"),
  });
  assert.equal((await runtimeVersion("codex", { host, env })).managedBy, "bun");
  await updateRuntime("codex", { host, env });
  assert.deepEqual(ran[0].argv, [`${root}/bin/bun`, "add", "--global", "@openai/codex@0.166.0"]);
  assert.equal(ran[0].env.BUN_INSTALL, root);
});

test("a bun global linked straight to the platform package", async () => {
  const root = "/home/me/.bun";
  const { host, ran, env } = fake({
    path: `${root}/bin`,
    executables: [`${root}/bin/claude`, `${root}/bin/bun`],
    links: { [`${root}/bin/claude`]: `${root}/install/global/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude` },
    version: "2.1.310 (Claude Code)",
    install: (machine) => void (machine.version = "2.1.316 (Claude Code)"),
  });
  const target = { executable: "claude", host, env };
  assert.equal((await runtimeVersion("claude", target)).managedBy, "bun");
  await updateRuntime("claude", target);
  assert.deepEqual(ran[0].argv, [`${root}/bin/bun`, "add", "--global", "--trust", "@anthropic-ai/claude-code@2.1.316"]);
});

test("a similarly named package is not the runtime's", async () => {
  const binary = `${NVM}/lib/node_modules/@openai/codex-tools/bin/codex.js`;
  const { host, env } = fake({ executables: [`${NVM}/bin/codex`, `${NVM}/bin/npm`], path: `${NVM}/bin`, links: { [`${NVM}/bin/codex`]: binary }, version: "1.0.0" });
  assert.equal((await runtimeVersion("codex", { host, env })).managedBy, "unknown");
});

test("a Homebrew cask: its own brew, the cask's own channel, and no exact versions", async () => {
  const brew = "/opt/homebrew";
  const { host, ran, looked, env } = fake({
    path: `${brew}/bin`,
    executables: [`${brew}/bin/claude`, `${brew}/bin/brew`],
    links: { [`${brew}/bin/claude`]: `${brew}/Caskroom/claude-code/2.1.300/claude` },
    documents: { "https://formulae.brew.sh/api/cask/claude-code.json": { version: "2.1.309" } },
    version: "2.1.300 (Claude Code)",
    install: (machine) => void (machine.version = "2.1.309 (Claude Code)"),
  });
  const target = { executable: "claude", host, env };
  const status = await runtimeVersion("claude", target);
  assert.equal(status.managedBy, "homebrew");
  assert.equal(status.latest, "2.1.309", "brew can only reach what the cask has, not npm's 2.1.316");
  assert.equal(status.canPinVersion, false);
  assert.equal(status.updateOffered, true);
  assert.deepEqual(looked.map((lookup) => lookup.url), ["https://formulae.brew.sh/api/cask/claude-code.json"]);
  assert.match((await failure(updateRuntime("claude", { ...target, version: "2.1.300" }), "not-updatable")).message, /Homebrew can only/);
  assert.equal(ran.length, 0);
  const result = await updateRuntime("claude", target);
  assert.deepEqual(ran[0].argv, [`${brew}/bin/brew`, "upgrade", "--cask", "claude-code"]);
  assert.equal(result.to, "2.1.309");
});

test("Homebrew's version of a package with a lib/node_modules inside is Homebrew's, and a cask or formula it does not know is left alone", async () => {
  const brew = "/usr/local";
  const { host, ran, env } = fake({
    path: `${brew}/bin`,
    executables: [`${brew}/bin/codex`, `${brew}/bin/brew`, `${brew}/bin/npm`],
    links: { [`${brew}/bin/codex`]: `${brew}/Cellar/codex/0.164.0/libexec/lib/node_modules/@openai/codex/bin/codex.js` },
    version: "codex-cli 0.164.0",
  });
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.managedBy, "homebrew");
  assert.equal(status.canUpdate, false);
  assert.match(status.reason ?? "", /does not manage/);
  await failure(updateRuntime("codex", { host, env }), "not-updatable");
  assert.deepEqual(ran, []);
});

test("Claude's native installer: its own updater, and exact versions through `claude install`", async () => {
  const home = "/home/me";
  const { host, ran, env } = fake({
    path: `${home}/.local/bin`,
    executables: [`${home}/.local/bin/claude`],
    links: { [`${home}/.local/bin/claude`]: `${home}/.local/share/claude/versions/2.1.310` },
    version: "2.1.310 (Claude Code)",
    install: (machine, argv) => void (machine.version = `${argv[2]} (Claude Code)`),
  });
  const target = { executable: "claude", host, env };
  const status = await runtimeVersion("claude", target);
  assert.equal(status.managedBy, "self");
  assert.equal(status.canPinVersion, true);
  await updateRuntime("claude", target);
  assert.deepEqual(ran[0].argv, [`${home}/.local/bin/claude`, "install", "2.1.316", "--force"]);
  await updateRuntime("claude", { ...target, version: "2.1.310" });
  assert.deepEqual(ran[1].argv, [`${home}/.local/bin/claude`, "install", "2.1.310", "--force"]);
});

test("Codex's standalone install: `codex update`, which only goes to the latest", async () => {
  const home = "/home/me";
  const { host, ran, env } = fake({
    path: `${home}/.local/bin`,
    executables: [`${home}/.local/bin/codex`],
    links: { [`${home}/.local/bin/codex`]: `${home}/.codex/packages/standalone/releases/0.164.0-aarch64-apple-darwin/bin/codex` },
    version: "codex-cli 0.164.0",
    install: (machine) => void (machine.version = "codex-cli 0.166.0"),
  });
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.managedBy, "self");
  assert.equal(status.canPinVersion, false);
  assert.match((await failure(updateRuntime("codex", { host, env, version: "0.164.0" }), "not-updatable")).message, /own updater can only/);
  await updateRuntime("codex", { host, env });
  assert.deepEqual(ran[0].argv, [`${home}/.local/bin/codex`, "update"]);
});

test("a binary nothing owns gets a reason, and is never updated", async () => {
  const { host, ran, env } = fake({ path: "/opt/odd/bin", executables: ["/opt/odd/bin/codex", "/opt/odd/bin/npm"], version: "codex-cli 0.164.0" });
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.managedBy, "unknown");
  assert.equal(status.canUpdate, false);
  assert.equal(status.version, "0.164.0");
  assert.equal(status.latest, "0.166.0");
  assert.equal(status.newerAvailable, true, "newer, even though this library cannot move to it");
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /Could not tell which installer owns \/opt\/odd\/bin\/codex/);
  await failure(updateRuntime("codex", { host, env }), "not-updatable");
  assert.deepEqual(ran, []);
});

test("Windows is reported as not supported", async () => {
  const binary = `${NVM}/lib/node_modules/@openai/codex/bin/codex.js`;
  const { host, env } = fake({ platform: "win32", executables: [binary, `${NVM}/bin/npm`], version: "codex-cli 0.164.0" });
  const status = await runtimeVersion("codex", { executable: binary, host, env });
  assert.equal(status.installed, true);
  assert.equal(status.managedBy, "unknown");
  assert.equal(status.canUpdate, false);
  assert.match(status.reason ?? "", /not supported on Windows/);
});

test("a missing runtime is a result, not an exception", async () => {
  const { host, env } = fake({ path: "/usr/bin" });
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.installed, false);
  assert.equal(status.version, undefined);
  assert.equal(status.latest, "0.166.0");
  assert.equal(status.compatible, undefined);
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /not installed/);
  await failure(updateRuntime("codex", { host, env }), "not-updatable");
});

test("an install that cannot say its version is offered as a repair, with the problem shown", async () => {
  const { host, ran, env } = fake(npmCodex({ version: undefined, install: (machine) => void (machine.version = "codex-cli 0.166.0") }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.installed, true);
  assert.equal(status.version, undefined);
  assert.equal(status.newerAvailable, false);
  assert.equal(status.updateOffered, true);
  assert.match(status.reason ?? "", /could not be read: stub/);
  const result = await updateRuntime("codex", { host, env });
  assert.equal(result.from, undefined);
  assert.equal(result.to, "0.166.0");
  assert.equal(ran.length, 1);
});

// A bundled Claude

const BUNDLED: BundledClaude = { sdkVersion: "0.3.308", claudeCodeVersion: "2.1.308", path: "/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" };

test("a bundled Claude reports the bundled version, the SDK's latest pairing, and that a release must move it", async () => {
  const { host, ran, looked, env } = fake({ bundled: BUNDLED, path: "/opt/homebrew/bin", executables: ["/opt/homebrew/bin/claude"], version: "9.9.9" });
  const status = await runtimeVersion("claude", { host, env });
  assert.equal(status.managedBy, "bundled");
  assert.equal(status.installed, true);
  assert.equal(status.version, "2.1.308", "from the SDK's pairing, not from the claude on PATH");
  assert.equal(status.latest, "2.1.316");
  assert.equal(status.path, BUNDLED.path);
  assert.deepEqual(status.sdk, { version: "0.3.308", latest: "0.3.316" });
  assert.equal(status.newerAvailable, true);
  assert.equal(status.canUpdate, false);
  assert.equal(status.updateOffered, false);
  assert.equal(status.updateCommand, undefined);
  assert.match(status.reason ?? "", /Moving to 2\.1\.316 takes a new app release with Agent SDK 0\.3\.316/);
  assert.deepEqual(looked.map((lookup) => lookup.url), [NPM_SDK]);
  const error = await failure(updateRuntime("claude", { host, env }), "not-updatable");
  assert.equal(error.from, "2.1.308");
  assert.deepEqual(ran, [], "the bundled copy is never touched");
});

test("a bundled Claude with its platform package missing says so", async () => {
  const { host, env } = fake({ bundled: { sdkVersion: "0.3.308", claudeCodeVersion: "2.1.308" } });
  const status = await runtimeVersion("claude", { host, env });
  assert.equal(status.installed, false);
  assert.equal(status.version, "2.1.308");
  assert.match(status.reason ?? "", /binary for this platform is not installed/);
});

test("an SDK that cannot be read is reported", async () => {
  const { host, env } = fake({});
  const status = await runtimeVersion("claude", { host, env });
  assert.equal(status.managedBy, "bundled");
  assert.equal(status.version, undefined);
  assert.match(status.reason ?? "", /could not be read/);
});

test("an executable pointed at the SDK's own copy is still bundled", async () => {
  const { host, env } = fake({ executables: [BUNDLED.path as string], version: "2.1.308 (Claude Code)" });
  const status = await runtimeVersion("claude", { executable: BUNDLED.path, host, env });
  assert.equal(status.managedBy, "bundled");
  assert.equal(status.latest, "2.1.316");
  assert.equal(status.canUpdate, false);
});

test("the real SDK's pairing is read from its package", async () => {
  const { bundledClaude: _fake, ...host } = fake({ offline: true }).host;
  const status = await runtimeVersion("claude", { host, env: {} });
  assert.equal(status.managedBy, "bundled");
  assert.match(status.sdk?.version ?? "", /^\d+\.\d+\.\d+/);
  assert.match(status.version ?? "", /^\d+\.\d+\.\d+/);
});

// What is offered

test("a new Codex major is not offered, with the reason, and is refused before anything runs", async () => {
  const { host, ran, env } = fake(npmCodex({ documents: { [NPM_CODEX]: { version: "1.0.0" } } }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.latest, "1.0.0");
  assert.equal(status.newerAvailable, true);
  assert.equal(status.canUpdate, true);
  assert.equal(status.latestCompatible, false);
  assert.match(status.latestIncompatibility ?? "", /different major/);
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /Codex 1\.0\.0 is not offered/);
  const error = await failure(updateRuntime("codex", { host, env }), "incompatible-target");
  assert.equal(error.target, "1.0.0");
  await failure(updateRuntime("codex", { host, env, version: "1.0.0" }), "incompatible-target");
  assert.deepEqual(ran, []);
});

test("a rollback below the floor is refused too, and the engine's own floor decides", async () => {
  const { host, ran, env } = fake(npmCodex());
  await failure(updateRuntime("codex", { host, env, version: "0.100.0" }), "incompatible-target");
  assert.deepEqual(ran, []);
  const status = await runtimeVersion("codex", { host, env, minimumVersion: "0.165.0" });
  assert.equal(status.compatible, false);
  assert.match(status.incompatibility ?? "", /older than/);
  assert.equal(status.latestCompatible, true);
});

test("up to date: nothing offered, no reason, and an update runs nothing", async () => {
  const { host, ran, env } = fake(npmCodex({ version: "codex-cli 0.166.0" }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.newerAvailable, false);
  assert.equal(status.updateOffered, false);
  assert.equal(status.reason, undefined);
  const result = await updateRuntime("codex", { host, env });
  assert.deepEqual({ outcome: result.outcome, from: result.from, to: result.to }, { outcome: "up-to-date", from: "0.166.0", to: "0.166.0" });
  await updateRuntime("codex", { host, env, version: "0.166.0" });
  assert.deepEqual(ran, []);
});

test("ahead of latest: an update does not move backwards unless a version is asked for", async () => {
  const { host, ran, env } = fake(npmCodex({ version: "codex-cli 0.167.0-alpha.1", install: (machine) => void (machine.version = "codex-cli 0.166.0") }));
  assert.equal((await runtimeVersion("codex", { host, env })).newerAvailable, false);
  assert.equal((await updateRuntime("codex", { host, env })).outcome, "up-to-date");
  assert.deepEqual(ran, []);
  const rollback = await updateRuntime("codex", { host, env, version: "0.166.0" });
  assert.deepEqual({ outcome: rollback.outcome, from: rollback.from, to: rollback.to }, { outcome: "updated", from: "0.167.0-alpha.1", to: "0.166.0" });
});

test("a release is newer than its own prerelease", async () => {
  const { host, env } = fake(npmCodex({ version: "codex-cli 0.166.0-alpha.2" }));
  assert.equal((await runtimeVersion("codex", { host, env })).newerAvailable, true);
});

test("an exact version installs that version, for rolling back", async () => {
  const { host, ran, looked, env } = fake(npmCodex({ version: "codex-cli 0.166.0", install: (machine) => void (machine.version = "codex-cli 0.164.0") }));
  const result = await updateRuntime("codex", { host, env, version: "0.164.0" });
  assert.equal(result.outcome, "updated");
  assert.equal(result.to, "0.164.0");
  assert.equal(ran[0].argv.at(-1), "@openai/codex@0.164.0");
  assert.deepEqual(looked, [], "an exact version needs no lookup");
});

// The lookup

test("offline: latest is unknown, nothing throws, and no update is offered", async () => {
  const { host, ran, env } = fake(npmCodex({ offline: true }));
  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.version, "0.164.0");
  assert.equal(status.latest, undefined);
  assert.equal(status.latestCompatible, undefined);
  assert.equal(status.newerAvailable, false);
  assert.equal(status.canUpdate, true);
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /could not be looked up/);
  assert.equal(status.updateCommand, undefined);
  await failure(updateRuntime("codex", { host, env }), "lookup-failed");
  assert.deepEqual(ran, [], "an unknown latest could be a new major, so nothing runs");
});

test("a bad registry answer counts as unknown", async () => {
  for (const document of [undefined, null, "oops", {}, { version: 7 }, { version: "latest; rm -rf /" }, { version: "--global" }, new Error("boom")]) {
    const { host, env } = fake(npmCodex({ documents: { [NPM_CODEX]: document } }));
    const status = await runtimeVersion("codex", { host, env });
    assert.equal(status.latest, undefined, String(document));
  }
});

test("the lookup sends only a fixed URL and an accept header, and stops at the timeout", async () => {
  const { host, looked, env } = fake(npmCodex());
  await runtimeVersion("codex", { host, env });
  assert.deepEqual(looked, [{ url: NPM_CODEX, headers: { accept: "application/json" } }]);

  let signal: AbortSignal | undefined;
  const hanging: Partial<RuntimeHost> = {
    ...host,
    fetch: (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    },
  };
  // The abort timer does not hold the process open on its own.
  const alive = setInterval(() => {}, 1);
  const status = await runtimeVersion("codex", { host: hanging, env, lookupTimeoutMs: 5 });
  clearInterval(alive);
  assert.equal(signal?.aborted, true);
  assert.equal(status.latest, undefined);
});

// How an update ends

test("a failed installer throws with its output, and the version read back", async () => {
  const { host, env } = fake(npmCodex({ install: () => ({ exitCode: 1, stdout: "", stderr: "npm error code EACCES\nnpm error path /nope\n" }) }));
  const error = await failure(updateRuntime("codex", { host, env }), "installer-failed");
  assert.equal(error.from, "0.164.0");
  assert.equal(error.to, "0.164.0");
  assert.equal(error.target, "0.166.0");
  assert.equal(error.exitCode, 1);
  assert.match(error.output ?? "", /EACCES/);
  assert.match(error.message, /exited with code 1/);
  assert.equal(error.command?.at(-1), "@openai/codex@0.166.0");
});

test("an installer that could not start or timed out fails the same way", async () => {
  const { host, env } = fake(npmCodex({ install: () => ({ exitCode: null, error: "it timed out after 10 ms" }) }));
  const error = await failure(updateRuntime("codex", { host, env }), "installer-failed");
  assert.equal(error.exitCode, null);
  assert.match(error.message, /timed out/);
});

test("exit 0 is not believed: a different version is a mismatch", async () => {
  const { host, env } = fake(npmCodex({ install: (machine) => void (machine.version = "codex-cli 0.165.0") }));
  const error = await failure(updateRuntime("codex", { host, env }), "version-mismatch");
  assert.equal(error.exitCode, 0);
  assert.equal(error.from, "0.164.0");
  assert.equal(error.to, "0.165.0");
  assert.equal(error.target, "0.166.0");
});

test("exit 0 is not believed: an unchanged version is a mismatch", async () => {
  const { host, env } = fake(npmCodex());
  const error = await failure(updateRuntime("codex", { host, env }), "version-mismatch");
  assert.equal(error.to, "0.164.0");
});

test("exit 0 is not believed: a binary that no longer runs is a mismatch", async () => {
  const { host, env } = fake(npmCodex({ install: (machine) => void (machine.version = undefined) }));
  const error = await failure(updateRuntime("codex", { host, env }), "version-mismatch");
  assert.equal(error.to, undefined);
  assert.match(error.message, /could not be read/);
});

test("an updater that cannot pin may land on another newer version, but must move", async () => {
  const brew = "/opt/homebrew";
  const machine = (install: FakeMachine["install"]): FakeMachine => ({
    path: `${brew}/bin`,
    executables: [`${brew}/bin/codex`, `${brew}/bin/brew`],
    links: { [`${brew}/bin/codex`]: `${brew}/Caskroom/codex/0.164.0/codex-aarch64-apple-darwin` },
    documents: { "https://formulae.brew.sh/api/cask/codex.json": { version: "0.166.0" } },
    version: "codex-cli 0.164.0",
    install,
  });
  const moved = fake(machine((state) => void (state.version = "codex-cli 0.167.0")));
  assert.equal((await updateRuntime("codex", { host: moved.host, env: moved.env })).to, "0.167.0");
  const stuck = fake(machine(() => undefined));
  await failure(updateRuntime("codex", { host: stuck.host, env: stuck.env }), "version-mismatch");
});

test("an updater that lands on a version the engine would refuse throws, with the version to go back to", async () => {
  const brew = "/opt/homebrew";
  const { host, env } = fake({
    path: `${brew}/bin`,
    executables: [`${brew}/bin/codex`, `${brew}/bin/brew`],
    links: { [`${brew}/bin/codex`]: `${brew}/Caskroom/codex/0.164.0/codex-aarch64-apple-darwin` },
    documents: { "https://formulae.brew.sh/api/cask/codex.json": { version: "0.166.0" } },
    version: "codex-cli 0.164.0",
    install: (machine) => void (machine.version = "codex-cli 1.0.0"),
  });
  const error = await failure(updateRuntime("codex", { host, env }), "incompatible-result");
  assert.equal(error.from, "0.164.0");
  assert.equal(error.to, "1.0.0");
  assert.match(error.message, /different major/);
});

test("a second update of the same binary is refused while the first runs", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const { host, env } = fake(npmCodex());
  const slow: Partial<RuntimeHost> = {
    ...host,
    exec: async (command, args, options) => {
      if (args[0] !== "--version") {
        await blocked;
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return host.exec!(command, args, options);
    },
  };
  const first = updateRuntime("codex", { host: slow, env });
  // Past the lookup and into the installer.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await failure(updateRuntime("codex", { host: slow, env }), "in-progress");
  release();
  await failure(first, "installer-failed");
  // Free again once it has ended.
  await failure(updateRuntime("codex", { host, env, version: "0.165.0" }), "version-mismatch");
});

test("anything but a strict semver is refused before a lookup or a command", async () => {
  const { host, ran, looked, env } = fake(npmCodex());
  const bad = ["latest", "", " ", "v0.166.0", "0.166", "0.166.0.1", "00.166.0", "0.166.0 ", " 0.166.0", "0.166.0\n", "--global", "-0.166.0", "0.166.0; rm -rf /", "0.166.0 && curl x", "$(id)", "`id`", "0.166.0-", "0.166.0-01", "0.166.0+build", "@openai/evil@1.0.0", "https://example.com/x.tgz", "file:../x", "0.166.x", "^0.166.0"];
  for (const version of bad) await failure(updateRuntime("codex", { host, env, version }), "invalid-version");
  assert.deepEqual(ran, []);
  assert.deepEqual(looked, []);
  for (const version of ["0.166.0", "0.166.0-alpha.1", "0.166.0-rc-2"]) {
    const accepted = await updateRuntime("codex", { host, env, version }).catch((error: RuntimeUpdateError) => error.reason);
    assert.equal(accepted, "version-mismatch", version);
  }
});

// The engines

test("CodexEngine: reports and updates the binary it runs, on its PATH and floor, without starting an app-server", async () => {
  const { host, ran, env } = fake(npmCodex({ install: (machine) => void (machine.version = "codex-cli 0.166.0") }));
  const engine = new CodexEngine({
    executable: `${NVM}/bin/codex`,
    env,
    minimumVersion: "0.165.0",
    spawnProcess: () => {
      throw new Error("no app-server should start");
    },
  });
  const status = await engine.runtimeVersion({ host });
  assert.equal(status.managedBy, "npm");
  assert.equal(status.compatible, false, "older than this engine's floor");
  assert.equal((await engine.updateRuntime({ host })).to, "0.166.0");
  assert.equal(ran.length, 1);
  assert.equal((await engine.capabilities()).runtimeUpdate, true);
});

test("ClaudeEngine: without an executable it is the SDK's copy; with one it is that binary", async () => {
  const bundled = fake({ bundled: BUNDLED });
  const engine = new ClaudeEngine({ sdk: fakeClaudeSdk().sdk, env: bundled.env });
  assert.equal((await engine.runtimeVersion({ host: bundled.host })).managedBy, "bundled");
  await failure(engine.updateRuntime({ host: bundled.host }), "not-updatable");

  const brew = "/opt/homebrew";
  const own = fake({
    path: `${NVM}/bin`,
    executables: [`${brew}/bin/claude`, `${NVM}/bin/npm`],
    links: { [`${brew}/bin/claude`]: `${brew}/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` },
    version: "2.1.100 (Claude Code)",
    install: (machine) => void (machine.version = "2.1.316 (Claude Code)"),
  });
  const external = new ClaudeEngine({ sdk: fakeClaudeSdk().sdk, executable: `${brew}/bin/claude`, env: own.env });
  const status = await external.runtimeVersion({ host: own.host });
  assert.equal(status.managedBy, "npm");
  assert.equal(status.compatible, false);
  assert.match(status.incompatibility ?? "", /too old/);
  assert.equal((await external.updateRuntime({ host: own.host })).to, "2.1.316");
  assert.equal((await external.capabilities()).runtimeUpdate, true);
});

test("AcpEngine: says plainly that it cannot, without starting the agent", async () => {
  const { host, ran, looked, env } = fake({ path: "/opt/bin", executables: ["/opt/bin/fake-agent"], links: { "/opt/bin/fake-agent": "/opt/lib/agent.js" } });
  let spawned = false;
  const engine = new AcpEngine({
    command: "fake-agent",
    env,
    spawnProcess: (...args) => {
      spawned = true;
      return fakeAcpSpawner().spawn(...args);
    },
  });
  const status = await engine.runtimeVersion({ host });
  assert.equal(status.provider, "acp");
  assert.equal(status.installed, true);
  assert.equal(status.path, "/opt/lib/agent.js");
  assert.equal(status.managedBy, "unknown");
  assert.equal(status.canUpdate, false);
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /cannot check or update ACP agents/);
  await assert.rejects(engine.updateRuntime(), UnsupportedFeatureError);
  assert.equal(spawned, false);
  assert.deepEqual(ran, []);
  assert.deepEqual(looked, []);
  assert.equal((await new AcpEngine({ command: "gone", env }).runtimeVersion({ host })).installed, false);
});

// The real host: real files, symlinks and processes, with a fake registry and a fake npm in a temp folder.

const folders: string[] = [];

after(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

/** Writes a runnable script. */
async function script(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

test("the real host: follows the symlink, runs without a shell, reads the version back", { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-updates-test-")));
  folders.push(root);
  const prefix = join(root, "a b; prefix");
  const packageBinary = join(prefix, "lib/node_modules/@openai/codex/bin/codex.js");
  const installed = join(root, "installed");
  await script(packageBinary, `echo "codex-cli $(cat "${installed}")"`);
  await writeFile(installed, "0.164.0\n");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await symlink("../lib/node_modules/@openai/codex/bin/codex.js", join(prefix, "bin/codex"));
  // Puts in place the version in its last argument, as npm would.
  await script(join(prefix, "bin/npm"), `for a in "$@"; do last="$a"; done; echo "\${last##*@}" > "${installed}"; echo done`);
  const host: Partial<RuntimeHost> = { fetch: fake({}).host.fetch };
  const env = { PATH: `${join(prefix, "bin")}:/usr/bin:/bin` };

  const status = await runtimeVersion("codex", { host, env });
  assert.equal(status.version, "0.164.0");
  assert.equal(status.path, packageBinary);
  assert.equal(status.managedBy, "npm");
  assert.equal(status.updateOffered, true);

  const result = await updateRuntime("codex", { host, env });
  assert.deepEqual({ outcome: result.outcome, from: result.from, to: result.to }, { outcome: "updated", from: "0.164.0", to: "0.166.0" });
  assert.match(result.output ?? "", /done/);
});

test("the real host: a binary that fails, an installer that fails, and a binary that is not there", { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-updates-test-")));
  folders.push(root);
  const binary = join(root, "lib/node_modules/@openai/codex/bin/codex.js");
  await script(binary, `echo "not today" >&2; exit 3`);
  await script(join(root, "bin/npm"), `echo "no permission" >&2; exit 7`);
  const host: Partial<RuntimeHost> = { fetch: fake({}).host.fetch };
  const env = { PATH: "/usr/bin:/bin" };
  const status = await runtimeVersion("codex", { executable: binary, host, env });
  assert.equal(status.installed, true);
  assert.equal(status.version, undefined);
  assert.match(status.reason ?? "", /could not be read: not today/);
  const error = await failure(updateRuntime("codex", { executable: binary, host, env }), "installer-failed");
  assert.equal(error.exitCode, 7);
  assert.match(error.output ?? "", /no permission/);
  assert.doesNotMatch(error.message, /Command failed/);
  assert.equal((await runtimeVersion("codex", { executable: join(root, "gone"), host, env })).installed, false);
});

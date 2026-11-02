/** @file Runtime versions and updates: who owns a binary, what is offered, and how an update ends. Everything runs on a fake machine unless it says otherwise. */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { AcpEngine } from "../src/acp/engine.ts";
import { ClaudeEngine } from "../src/claude/engine.ts";
import { CodexEngine } from "../src/codex/engine.ts";
import { RuntimeUpdateError, UnsupportedFeatureError, type RuntimeUpdateFailure } from "../src/errors.ts";
import { findSharedClaude, runtimeReleaseNotes, runtimeVersion, updateRuntime } from "../src/runtime-updates.ts";
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
  /** What `pnpm --version` prints; defaults to 11.0.0. */
  pnpmVersion?: string;
  /** Runs the installer: return what it reports, and set `machine.version` to change the binary. */
  install?: (machine: FakeMachine, argv: readonly string[]) => Partial<RuntimeExecResult> | void;
  /** Registry answers by URL; an Error fails the lookup. Merged over `PUBLISHED`. */
  documents?: Record<string, unknown>;
  /** Every lookup fails, as when offline. */
  offline?: boolean;
  bundled?: BundledClaude;
  /** What an Agent SDK session on the binary reports; an Error fails it. Defaults to what `--version` prints. */
  session?: string | Error;
  platform?: NodeJS.Platform;
}

/** Builds a fake host, and records every command and lookup it is asked for. */
function fake(machine: FakeMachine) {
  const ran: Array<{ argv: string[]; env: Readonly<Record<string, string | undefined>>; cwd?: string }> = [];
  const looked: Array<{ url: string; headers: Record<string, string> }> = [];
  const sessions: string[] = [];
  const host: Partial<RuntimeHost> = {
    platform: machine.platform ?? "darwin",
    exec: async (command, args, options) => {
      const argv = [command, ...args];
      if (args[0] === "--version") {
        if (basename(command) === "pnpm") return { exitCode: 0, stdout: `${machine.pnpmVersion ?? "11.0.0"}\n`, stderr: "" };
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
      return { ok: document !== undefined, json: async () => document, text: async () => String(document) };
    },
    realpath: async (path) => machine.links?.[path] ?? path,
    isExecutable: async (path) => (machine.executables ?? []).includes(path),
    readText: async (path) => machine.texts?.[path],
    bundledClaude: async () => machine.bundled,
    claudeSession: async (binary) => {
      sessions.push(binary);
      if (machine.session instanceof Error) throw machine.session;
      return machine.session ?? machine.version?.split(" ")[0];
    },
  };
  return { host, ran, looked, sessions, env: { PATH: machine.path ?? "/usr/bin" } };
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
  assert.deepEqual(ran[0].argv, [`${home}/pnpm`, "add", "--global", "--global-dir", `${home}/global`, "--global-bin-dir", home, "@openai/codex@0.166.0"]);
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
  assert.deepEqual(ran[0].argv, ["/opt/tools/bin/pnpm", "add", "--global", "--global-dir", `${home}/global`, "--global-bin-dir", `${home}/bin`, "--allow-build=@anthropic-ai/claude-code", "@anthropic-ai/claude-code@2.1.316"]);
  assert.equal(ran[0].env.PNPM_HOME, home);
});

test("pnpm 12 refuses --global-bin-dir, so the bin folder is pinned through its environment", async () => {
  const home = "/home/me/Library/pnpm";
  const { host, ran, env } = fake({
    path: `${home}/bin`,
    executables: [`${home}/bin/codex`, `${home}/bin/pnpm`],
    texts: { [`${home}/bin/codex`]: `#!/bin/sh\nexec node "$basedir_abs/../global/v11/abc123/node_modules/@openai/codex/bin/codex.js" "$@"\n` },
    version: "codex-cli 0.164.0",
    pnpmVersion: "12.0.0",
    install: (machine) => void (machine.version = "codex-cli 0.166.0"),
  });
  await updateRuntime("codex", { host, env: { ...env, PNPM_CONFIG_GLOBAL_BIN_DIR: "/other/bin" } });
  assert.deepEqual(ran[0].argv, [`${home}/bin/pnpm`, "add", "--global", "--global-dir", `${home}/global`, "@openai/codex@0.166.0"]);
  assert.equal(ran[0].env.PNPM_CONFIG_GLOBAL_BIN_DIR, `${home}/bin`);
  assert.equal(ran[0].env.pnpm_config_global_bin_dir, `${home}/bin`);
});

test("pnpm before 10.4 cannot allow Claude Code's install script, so that update is not offered; Codex has no script and still is", async () => {
  const home = "/home/me/.local/share/pnpm";
  const machine = (command: string, target: string, version: string): FakeMachine => ({
    path: home,
    executables: [`${home}/${command}`, `${home}/pnpm`],
    texts: { [`${home}/${command}`]: `#!/bin/sh\nexec node "$basedir/global/5/.pnpm/x/node_modules/${target}" "$@"\n` },
    version,
    pnpmVersion: "10.3.0",
    install: (self) => void (self.version = "0.166.0"),
  });
  const claude = fake(machine("claude", "@anthropic-ai/claude-code/bin/claude.exe", "2.1.310 (Claude Code)"));
  const target = { executable: "claude", host: claude.host, env: claude.env };
  const status = await runtimeVersion("claude", target);
  assert.equal(status.managedBy, "pnpm");
  assert.equal(status.canUpdate, false);
  assert.equal(status.updateOffered, false);
  assert.match(status.reason ?? "", /pnpm 10\.4 or newer.*10\.3\.0/u);
  await failure(updateRuntime("claude", target), "not-updatable");
  assert.equal(claude.ran.length, 0);

  const codex = fake(machine("codex", "@openai/codex/bin/codex.js", "codex-cli 0.164.0"));
  assert.equal((await updateRuntime("codex", { host: codex.host, env: codex.env })).to, "0.166.0");
  assert.equal(codex.ran[0].argv.includes("--global-bin-dir"), true);
});

test("a pnpm home under a symlinked folder keeps the spelling on PATH, because pnpm compares its store location as text", async () => {
  const { host, ran, env } = fake({
    path: "/tmp/pnpm",
    executables: ["/tmp/pnpm/codex", "/tmp/pnpm/pnpm"],
    links: { "/tmp/pnpm": "/private/tmp/pnpm", "/tmp/pnpm/codex": "/private/tmp/pnpm/codex" },
    texts: { "/private/tmp/pnpm/codex": `#!/bin/sh\nexec node "$basedir/global/5/node_modules/@openai/codex/bin/codex.js" "$@"\n` },
    version: "codex-cli 0.164.0",
    install: (machine) => void (machine.version = "codex-cli 0.166.0"),
  });
  await updateRuntime("codex", { host, env });
  assert.equal(ran[0].env.PNPM_HOME, "/tmp/pnpm");
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

test("global destination overrides cannot redirect Bun or pnpm to another install", async () => {
  for (const manager of ["bun", "pnpm"] as const) {
    const root = `/home/me/.${manager}`;
    const bin = join(root, "bin");
    const globalDir = manager === "bun" ? join(root, "install/global") : join(root, "global");
    const binary = join(bin, "codex");
    const machine: FakeMachine = {
      path: bin,
      executables: [binary, join(bin, manager)],
      links: { [binary]: join(globalDir, manager === "bun" ? "node_modules/@openai/codex/bin/codex.js" : "v11/abc/node_modules/@openai/codex/bin/codex.js") },
      version: "codex-cli 0.164.0",
    };
    const { host, env, ran } = fake(machine);
    const configuredEnv = { ...env, BUN_INSTALL_GLOBAL_DIR: "/other/global", BUN_INSTALL_BIN: "/other/bin", PNPM_CONFIG_GLOBAL_DIR: "/other/global", PNPM_CONFIG_GLOBAL_BIN_DIR: "/other/bin" };
    const redirected: Partial<RuntimeHost> = {
      ...host,
      exec: async (command, args, options) => {
        if (args[0] !== "--version") {
          const flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
          const destination = manager === "bun" ? options.env.BUN_INSTALL_GLOBAL_DIR : flag("--global-dir") ?? options.env.PNPM_CONFIG_GLOBAL_DIR;
          const bins = manager === "bun" ? options.env.BUN_INSTALL_BIN : flag("--global-bin-dir") ?? options.env.PNPM_CONFIG_GLOBAL_BIN_DIR;
          if (destination === globalDir && bins === bin) machine.version = "codex-cli 0.166.0";
        }
        return host.exec!(command, args, options);
      },
    };
    assert.equal((await updateRuntime("codex", { host: redirected, env: configuredEnv })).to, "0.166.0", manager);
    assert.equal(ran.length, 1);
  }
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
  assert.deepEqual(looked.map((lookup) => lookup.url).sort(), ["https://formulae.brew.sh/api/cask/claude-code.json", NPM_SDK]);
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
  assert.deepEqual(status.sdk, { version: "0.3.308", claudeCode: "2.1.308", latest: "0.3.316" });
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

test("prereleases follow semver order when offering and applying updates", async () => {
  for (const [from, to] of [
    ["0.166.0-alpha.2", "0.166.0-alpha.10"],
    ["0.166.0-alpha.10", "0.166.0-beta.1"],
    ["0.166.0-alpha", "0.166.0-alpha.1"],
    ["0.166.0-1", "0.166.0-alpha"],
    ["0.166.0-alpha.9007199254740992", "0.166.0-alpha.9007199254740993"],
  ]) {
    const { host, env } = fake(npmCodex({
      version: `codex-cli ${from}`,
      documents: { [NPM_CODEX]: { version: to } },
      install: (machine) => void (machine.version = `codex-cli ${to}`),
    }));
    assert.equal((await runtimeVersion("codex", { host, env })).updateOffered, true, `${from} to ${to}`);
    assert.equal((await updateRuntime("codex", { host, env })).outcome, "updated");
    assert.equal((await runtimeVersion("codex", { host, env })).updateOffered, false);
    const older = fake(npmCodex({ version: `codex-cli ${to}`, documents: { [NPM_CODEX]: { version: from } } }));
    assert.equal((await updateRuntime("codex", { host: older.host, env: older.env })).outcome, "up-to-date");
  }
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
  for (const version of ["0.164.1", "0.165.0"]) {
    const stale = fake(machine((state) => void (state.version = `codex-cli ${version}`)));
    await failure(updateRuntime("codex", { host: stale.host, env: stale.env }), "version-mismatch");
  }
  const downgraded = fake({ ...machine((state) => void (state.version = "codex-cli 0.164.0")), version: "codex-cli 0.165.0" });
  await failure(updateRuntime("codex", { host: downgraded.host, env: downgraded.env }), "version-mismatch");
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

test("updates through aliases share a lock", async () => {
  let release = () => {};
  let started = () => {};
  const blocked = new Promise<void>((done) => (release = done));
  const installing = new Promise<void>((done) => (started = done));
  const alias = "/opt/bin/codex";
  const binary = `${NVM}/lib/node_modules/@openai/codex/bin/codex.js`;
  const { host, env } = fake(npmCodex({
    executables: [`${NVM}/bin/codex`, `${NVM}/bin/npm`, alias],
    links: { [`${NVM}/bin/codex`]: binary, [alias]: binary },
  }));
  const slow: Partial<RuntimeHost> = {
    ...host,
    exec: async (command, args, options) => {
      if (args[0] === "--version") return host.exec!(command, args, options);
      started();
      await blocked;
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  };
  const first = updateRuntime("codex", { host: slow, env });
  await installing;
  try {
    // A second installer must not start, so use a host that would fail immediately if it did.
    await failure(updateRuntime("codex", { host, env, executable: alias }), "in-progress");
  } finally {
    release();
    await failure(first, "installer-failed");
  }
});

test("a native update stays locked after its symlink points to the new version", async () => {
  const binary = "/home/me/.local/bin/claude";
  const machine: FakeMachine = {
    executables: [binary],
    links: { [binary]: "/home/me/.local/share/claude/versions/2.1.310" },
    version: "2.1.310 (Claude Code)",
  };
  const { host, env } = fake(machine);
  let release = () => {};
  let started = () => {};
  const blocked = new Promise<void>((done) => (release = done));
  const installing = new Promise<void>((done) => (started = done));
  const slow: Partial<RuntimeHost> = {
    ...host,
    exec: async (command, args, options) => {
      if (args[0] === "--version") return host.exec!(command, args, options);
      machine.links![binary] = "/home/me/.local/share/claude/versions/2.1.316";
      machine.version = "2.1.316 (Claude Code)";
      started();
      await blocked;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const first = updateRuntime("claude", { executable: binary, host: slow, env });
  await installing;
  try {
    await failure(updateRuntime("claude", { executable: binary, host, env, version: "2.1.310" }), "in-progress");
  } finally {
    release();
    assert.equal((await first).to, "2.1.316");
  }
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

// Finding the shared Claude

/** The `claude` on PATH as an npm global, under a prefix found on the given PATH. */
function sharedClaude(extra: Partial<FakeMachine> = {}): FakeMachine {
  return {
    path: "/usr/bin:/opt/homebrew/bin",
    executables: ["/opt/homebrew/bin/claude"],
    links: { "/opt/homebrew/bin/claude": "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe" },
    version: "2.1.310 (Claude Code)",
    ...extra,
  };
}

test("findSharedClaude: the first claude on the given PATH, absolute and unresolved, with its version", async () => {
  const { host, env } = fake(sharedClaude());
  assert.deepEqual(await findSharedClaude({ host, env }), { path: "/opt/homebrew/bin/claude", version: "2.1.310" });
});

test("findSharedClaude: a relative PATH entry still gives an absolute path", async () => {
  const absolute = resolve("tools/claude");
  const { host } = fake({ executables: [absolute], version: "2.1.310 (Claude Code)" });
  assert.deepEqual(await findSharedClaude({ host, env: { PATH: "tools" } }), { path: absolute, version: "2.1.310" });
});

test("findSharedClaude: nothing when it is off a thin PATH, does not run, is too old or says no version", async () => {
  const thin = fake(sharedClaude());
  assert.equal(await findSharedClaude({ host: thin.host, env: { PATH: "/usr/bin:/bin" } }), undefined);
  const noPath = fake(sharedClaude());
  assert.equal(await findSharedClaude({ host: noPath.host, env: {} }), undefined);
  const stub = fake(sharedClaude({ version: undefined }));
  assert.equal(await findSharedClaude({ host: stub.host, env: stub.env }), undefined);
  const old = fake(sharedClaude({ version: "2.1.100 (Claude Code)" }));
  assert.equal(await findSharedClaude({ host: old.host, env: old.env }), undefined);
  const garbled = fake(sharedClaude({ version: "who knows" }));
  assert.equal(await findSharedClaude({ host: garbled.host, env: garbled.env }), undefined);
});

test("findSharedClaude: the minimum can be raised, and it starts no session and looks nothing up", async () => {
  const { host, env, ran, looked, sessions } = fake(sharedClaude());
  assert.equal(await findSharedClaude({ host, env, minimumVersion: "2.1.311" }), undefined);
  assert.equal((await findSharedClaude({ host, env, minimumVersion: "2.1.310" }))?.version, "2.1.310");
  assert.deepEqual([ran.length, looked.length, sessions.length], [0, 0, 0]);
});

// Checking the SDK against the new Claude

const SHARED_UPDATE: Partial<FakeMachine> = {
  path: `${NVM}/bin:/opt/homebrew/bin`,
  executables: ["/opt/homebrew/bin/claude", `${NVM}/bin/npm`],
  install: (machine) => void (machine.version = "2.1.316 (Claude Code)"),
};

test("a Claude update opens an SDK session on the binary it updated, and passes when the versions agree", async () => {
  const { host, env, sessions } = fake(sharedClaude(SHARED_UPDATE));
  const result = await updateRuntime("claude", { executable: "claude", host, env });
  assert.equal(result.to, "2.1.316");
  assert.deepEqual(sessions, ["/opt/homebrew/bin/claude"]);
});

test("a session reporting another version fails the update, with the version to go back to", async () => {
  const { host, env } = fake(sharedClaude({ ...SHARED_UPDATE, session: "2.1.310" }));
  const error = await failure(updateRuntime("claude", { executable: "claude", host, env }), "sdk-check-failed");
  assert.match(error.message, /Claude Code reports 2\.1\.316, but a session through the Agent SDK reports 2\.1\.310/);
  assert.equal(error.from, "2.1.310");
  assert.equal(error.to, "2.1.316");
  assert.equal(error.exitCode, 0);
});

test("a session that will not start, or reports no version, fails the update", async () => {
  const broken = fake(sharedClaude({ ...SHARED_UPDATE, session: new Error("Claude Code process exited with code 1") }));
  const error = await failure(updateRuntime("claude", { executable: "claude", host: broken.host, env: broken.env }), "sdk-check-failed");
  assert.match(error.message, /could not open a session on it: Claude Code process exited/);
  const silent = fake(sharedClaude(SHARED_UPDATE));
  const host = { ...silent.host, claudeSession: async () => undefined };
  assert.match((await failure(updateRuntime("claude", { executable: "claude", host, env: silent.env }), "sdk-check-failed")).message, /reports no version/);
});

test("no session when nothing ran, the installer failed, or the provider is Codex", async () => {
  const current = fake(sharedClaude({ ...SHARED_UPDATE, version: "2.1.316 (Claude Code)" }));
  assert.equal((await updateRuntime("claude", { executable: "claude", host: current.host, env: current.env })).outcome, "up-to-date");
  assert.equal(current.sessions.length, 0);
  const failed = fake(sharedClaude({ ...SHARED_UPDATE, install: () => ({ exitCode: 1 }) }));
  await failure(updateRuntime("claude", { executable: "claude", host: failed.host, env: failed.env }), "installer-failed");
  assert.equal(failed.sessions.length, 0);
  const codex = fake(npmCodex({ install: (machine) => void (machine.version = "codex-cli 0.166.0") }));
  await updateRuntime("codex", { host: codex.host, env: codex.env });
  assert.equal(codex.sessions.length, 0);
});

test("ClaudeEngine checks through its own SDK and environment, on the absolute binary, sending no prompt", async () => {
  const { claudeSession: _fake, ...host } = fake(sharedClaude(SHARED_UPDATE)).host;
  const { sdk, queries } = fakeClaudeSdk({ version: "2.1.316" });
  const engine = new ClaudeEngine({ sdk, executable: "/opt/homebrew/bin/claude", env: { PATH: `${NVM}/bin`, ANTHROPIC_API_KEY: "sk-test" }, configDir: "/tmp/claude-config" });
  assert.equal((await engine.updateRuntime({ host })).to, "2.1.316");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].options.pathToClaudeCodeExecutable, "/opt/homebrew/bin/claude");
  assert.equal(queries[0].options.persistSession, false);
  assert.deepEqual(queries[0].options.tools, []);
  assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, "/tmp/claude-config");
  assert.equal(queries[0].options.env.ANTHROPIC_API_KEY, undefined, "an engine that refuses API keys does not pass them on");
  assert.deepEqual(queries[0].inputs, [], "no message, so no model turn");
  assert.equal(queries[0].closed, true);
});

test("ClaudeEngine: a thread prewarmed before an update is closed, so the next one starts on the new binary", async () => {
  const { host } = fake(sharedClaude(SHARED_UPDATE));
  const { sdk, queries } = fakeClaudeSdk({ version: "2.1.316" });
  const engine = new ClaudeEngine({ sdk, executable: "/opt/homebrew/bin/claude", env: { PATH: `${NVM}/bin` } });
  await engine.prewarm({ cwd: "/tmp" });
  assert.equal(queries.length, 1);
  await engine.updateRuntime({ host });
  assert.equal(queries[0].closed, true);
  await engine.startThread({ cwd: "/tmp" });
  assert.equal(queries.length, 2, "not the old process");
  await engine.close();
});

test("ClaudeEngine: its SDK reporting another version fails the update", async () => {
  const { claudeSession: _fake, ...host } = fake(sharedClaude(SHARED_UPDATE)).host;
  const engine = new ClaudeEngine({ sdk: fakeClaudeSdk({ version: "2.1.310" }).sdk, executable: "/opt/homebrew/bin/claude", env: { PATH: `${NVM}/bin` } });
  await failure(engine.updateRuntime({ host }), "sdk-check-failed");
});

test("status shows the SDK and the binary apart for a shared Claude, and not at all for Codex", async () => {
  const { host, env } = fake(sharedClaude({ bundled: BUNDLED, executables: ["/opt/homebrew/bin/claude", "/usr/bin/npm"] }));
  const status = await runtimeVersion("claude", { executable: "claude", host, env });
  assert.equal(status.managedBy, "npm");
  assert.equal(status.version, "2.1.310");
  assert.deepEqual(status.sdk, { version: "0.3.308", claudeCode: "2.1.308", latest: "0.3.316" });
  const unread = fake(sharedClaude());
  assert.equal((await runtimeVersion("claude", { executable: "claude", host: unread.host, env: unread.env })).sdk, undefined);
  const codex = fake(npmCodex({ bundled: BUNDLED }));
  assert.equal((await runtimeVersion("codex", { host: codex.host, env: codex.env })).sdk, undefined);
});

// Release notes

const CHANGELOG = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
const GITHUB = "https://api.github.com/repos/openai/codex";

/** GitHub's tag list for one minor version. */
function tags(minor: string, versions: unknown[]): Record<string, unknown> {
  return { [`${GITHUB}/git/matching-refs/tags/rust-v${minor}.?per_page=100`]: versions.map((version) => (typeof version === "string" ? { ref: `refs/tags/rust-v${version}` } : version)) };
}

/** One GitHub release, by its tag. */
function release(version: string, body: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [`${GITHUB}/releases/tags/rust-v${version}`]: { tag_name: `rust-v${version}`, body, draft: false, ...extra } };
}

test("Codex notes: versions after from up to and including to, per version, newest first, patches in, prereleases out", async () => {
  const { host, looked } = fake({
    documents: {
      ...tags("0.166", ["0.166.0", "0.166.0-alpha.1", "0.166.1"]),
      ...tags("0.165", ["0.165.0", "0.165.0-alpha.1"]),
      ...tags("0.164", ["0.164.0", "0.164.1", "0.164.1-alpha.1"]),
      ...release("0.166.0", "## New\n- Added a thing (#1)\n"),
      ...release("0.165.0", "## Fixes\r\n- [link](https://example.com) and **bold** and `code`\r\n"),
      ...release("0.164.1", "a patch of from's minor"),
      ...release("0.166.1", "after to"),
      ...release("0.164.0", "from itself"),
    },
  });
  assert.deepEqual(await runtimeReleaseNotes("codex", { from: "0.164.0", to: "0.166.0", host }), [
    { version: "0.166.0", text: "New\n- Added a thing (#1)" },
    { version: "0.165.0", text: "Fixes\n- link and bold and code" },
    { version: "0.164.1", text: "a patch of from's minor" },
  ]);
  const urls = looked.map((lookup) => lookup.url);
  assert.equal(urls.length, 6, "three tag lists and three releases, and never the whole list of releases");
  assert.ok(urls.every((url) => url.startsWith(`${GITHUB}/git/matching-refs/tags/rust-v0.16`) || url.startsWith(`${GITHUB}/releases/tags/rust-v0.16`)), urls.join());
  assert.ok(looked.every((lookup) => lookup.headers.accept === "application/vnd.github+json" && Object.keys(lookup.headers).length === 1), "no identity sent");
});

test("Codex notes: a prerelease only when it is the target; drafts, odd tags and empty bodies are left out", async () => {
  const { host } = fake({
    documents: {
      ...tags("0.167", ["0.167.0-alpha.1", "0.167.0-alpha.2"]),
      ...tags("0.166", ["0.166.0", "0.166.5", "0.166.6", "0.166.7", null, { ref: 7 }, { ref: "refs/tags/rust-v.odd" }, "not-a-version"]),
      ...release("0.167.0-alpha.2", "the target"),
      ...release("0.166.0", "kept"),
      ...release("0.166.5", "unfinished", { draft: true }),
      ...release("0.166.6", ""),
      ...release("0.166.7", null),
    },
  });
  assert.deepEqual(await runtimeReleaseNotes("codex", { from: "0.165.9", to: "0.167.0-alpha.2", host }), [
    { version: "0.167.0-alpha.2", text: "the target" },
    { version: "0.166.0", text: "kept" },
  ]);
});

test("Codex notes include a later prerelease of the same version", async () => {
  const { host } = fake({ documents: release("0.167.0-alpha.10", "new prerelease") });
  assert.deepEqual(await runtimeReleaseNotes("codex", { from: "0.167.0-alpha.2", to: "0.167.0-alpha.10", host }), [
    { version: "0.167.0-alpha.10", text: "new prerelease" },
  ]);
});

test("Codex notes: one missing or failed piece keeps the rest", async () => {
  const listFailed = fake({ documents: { ...tags("0.165", ["0.165.0"]), [`${GITHUB}/git/matching-refs/tags/rust-v0.166.?per_page=100`]: new Error("rate limited"), ...release("0.166.0", "to is tried anyway"), ...release("0.165.0", "older") } });
  assert.deepEqual((await runtimeReleaseNotes("codex", { from: "0.164.9", to: "0.166.0", host: listFailed.host })).map((note) => note.version), ["0.166.0", "0.165.0"]);
  const noRelease = fake({ documents: { ...tags("0.166", ["0.166.0", "0.166.1"]), ...release("0.166.1", "has notes") } });
  assert.deepEqual((await runtimeReleaseNotes("codex", { from: "0.165.9", to: "0.166.1", host: noRelease.host })).map((note) => note.version), ["0.166.1"]);
});

test("Codex notes: a long jump reads only the newest minors, and a new major only the target", async () => {
  const jump = fake({ documents: { ...tags("0.166", ["0.166.0"]), ...release("0.166.0", "newest") } });
  await runtimeReleaseNotes("codex", { from: "0.100.0", to: "0.166.0", host: jump.host });
  assert.ok(jump.looked.length <= 11, `${jump.looked.length} calls`);
  assert.ok(!jump.looked.some((lookup) => lookup.url.includes("rust-v0.156.")), "ten minors, newest first");
  const major = fake({ documents: release("1.0.0", "a new major") });
  assert.deepEqual(await runtimeReleaseNotes("codex", { from: "0.166.0", to: "1.0.0", host: major.host }), [{ version: "1.0.0", text: "a new major" }]);
  assert.equal(major.looked.length, 1);
});

test("Claude notes: read from the changelog, per version, and versions with no entry are simply missing", async () => {
  const changelog = [
    "# Changelog\n\n## 2.1.316\n\n- Added `X`\n- Fixed Y\n",
    "## 2.1.314\n\n- Fixed Z\n",
    "## 2.1.312\n\n",
    "## 2.1.311\n- Fixed W\n",
    "## Unreleased\n- Not a version\n",
    "## 2.1.310\n- Old\n",
  ].join("\n");
  const { host, looked } = fake({ documents: { [CHANGELOG]: changelog } });
  assert.deepEqual(await runtimeReleaseNotes("claude", { from: "2.1.310", to: "2.1.316", host }), [
    { version: "2.1.316", text: "- Added X\n- Fixed Y" },
    { version: "2.1.314", text: "- Fixed Z" },
    { version: "2.1.311", text: "- Fixed W" },
  ]);
  assert.deepEqual(looked, [{ url: CHANGELOG, headers: { accept: "text/plain" } }]);
});

test("notes: any failure is no notes, and bad versions never reach a URL", async () => {
  const offline = fake({ offline: true });
  assert.deepEqual(await runtimeReleaseNotes("codex", { from: "0.164.0", to: "0.166.0", host: offline.host }), []);
  assert.deepEqual(await runtimeReleaseNotes("claude", { from: "2.1.310", to: "2.1.316", host: offline.host }), []);
  for (const document of [undefined, "not a list", { message: "API rate limit exceeded" }, new Error("boom")]) {
    const { host } = fake({ documents: { [`${GITHUB}/git/matching-refs/tags/rust-v0.166.?per_page=100`]: document, [`${GITHUB}/releases/tags/rust-v0.166.0`]: document } });
    assert.deepEqual(await runtimeReleaseNotes("codex", { from: "0.165.9", to: "0.166.0", host }), [], String(document));
  }
  const empty = fake({ documents: { [CHANGELOG]: "no sections in here" } });
  assert.deepEqual(await runtimeReleaseNotes("claude", { from: "2.1.310", to: "2.1.316", host: empty.host }), []);

  const untouched = fake({});
  for (const [from, to] of [["0.164.0", "latest"], ["../x", "0.166.0"], ["0.166.0", "0.166.0"], ["0.166.0", "0.164.0"]]) {
    assert.deepEqual(await runtimeReleaseNotes("codex", { from, to, host: untouched.host }), [], `${from} to ${to}`);
  }
  assert.equal(untouched.looked.length, 0, "a bad, equal or backwards range looks nothing up");
});

test("notes: a hung fetch stops at the timeout and gives no notes", async () => {
  const hanging: Partial<RuntimeHost> = {
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  };
  // The abort timer does not hold the process open on its own.
  const alive = setInterval(() => {}, 1);
  assert.deepEqual(await runtimeReleaseNotes("claude", { from: "2.1.310", to: "2.1.316", timeoutMs: 5, host: hanging }), []);
  clearInterval(alive);
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

/**
 * @file The version of a runtime on this machine, the latest one published, and
 * moving between them with the installer that owns the binary.
 *
 * Mechanics only: when to check, whether to prompt and when to restart stay with
 * the app. The owner is read from where the binary really lives, so an update
 * reaches the copy the engine runs and not whichever package manager comes first
 * on PATH. Commands run without a shell and with fixed package names, and only a
 * strict semver reaches one. An update counts when the binary says so afterwards,
 * not when the installer exits 0.
 */

import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile, type ExecFileException } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { CODEX_PROTOCOL_VERSION, codexVersionIncompatibility } from "./codex/protocol/version.ts";
import { CLAUDE_CODE_MIN_VERSION, checkMinimumVersion, compareVersions, parseRuntimeVersion } from "./compat.ts";
import { AgentEngineError, RuntimeUpdateError } from "./errors.ts";
import type {
  BundledClaude,
  ProviderId,
  RuntimeCheckOptions,
  RuntimeExecResult,
  RuntimeHost,
  RuntimeManager,
  RuntimeReleaseNote,
  RuntimeUpdateOptions,
  RuntimeUpdateResult,
  RuntimeVersionStatus,
  SharedClaude,
} from "./types.ts";

/** The runtimes this library can check and update. */
type ManagedProvider = Exclude<ProviderId, "acp">;

/** A child environment. */
type Env = Readonly<Record<string, string | undefined>>;

/** Which binary a check is about. An engine fills these in from its own options. */
export interface RuntimeTarget {
  /** Defaults to the command on PATH, or for Claude to the binary the SDK bundles. */
  executable?: string;
  /** Whose PATH finds the binary; defaults to the current environment. */
  env?: Env;
  /** Oldest accepted version; defaults to what this library was built against. */
  minimumVersion?: string;
}

/** How long a latest-version lookup may take. */
const LOOKUP_TIMEOUT_MS = 5_000;

/** How long `<binary> --version` may take. */
const VERSION_TIMEOUT_MS = 10_000;

/** How long an installer may run: a native Claude Code is a large download. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;

/** How long the Agent SDK may take to initialise on an updated binary. */
const SESSION_TIMEOUT_MS = 30_000;

/** How long one fetch of release notes may take. Claude's changelog is over a megabyte. */
const NOTES_TIMEOUT_MS = 10_000;

/** The most Codex minor versions read, newest first: each costs GitHub API calls, of about 60 an hour without a sign-in. */
const MAX_NOTES_MINORS = 10;

/** How much of an installer's output is kept. */
const MAX_OUTPUT_CHARS = 16_000;

/** How much of a file is read to recognise a launcher script. */
const MAX_SHIM_BYTES = 64 * 1024;

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Per provider: its fixed package and cask names, the installs its own updater
 * owns, and what that updater can do.
 */
const SPECS = {
  codex: {
    name: "Codex",
    command: "codex",
    package: "@openai/codex",
    casks: ["codex"],
    /** The standalone installer, under `CODEX_HOME`. */
    selfManaged: /\/packages\/standalone\//u,
    /** `codex update` only goes to the latest release. */
    selfCommand: (binary: string, _version: string): readonly string[] => [binary, "update"],
    selfPins: false,
    /** Its npm package has no install script to allow. */
    installScript: false,
  },
  claude: {
    name: "Claude Code",
    command: "claude",
    package: "@anthropic-ai/claude-code",
    casks: ["claude-code", "claude-code@latest"],
    /** The native installer's versions folder. */
    selfManaged: /\/claude\/versions\//u,
    /** Not `claude update`, which follows the user's release channel and would not reach the version reported. */
    selfCommand: (binary: string, version: string): readonly string[] => [binary, "install", version, "--force"],
    selfPins: true,
    /** Its postinstall puts the native binary in place; a package manager that blocks it leaves a stub. */
    installScript: true,
  },
} as const;

type Spec = (typeof SPECS)[ManagedProvider];

/** `major.minor.patch[-prerelease]`, per semver.org. Build metadata means nothing to a registry, so it is refused too. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/u;

/** Whether `version` is safe to pass to an installer. */
function isStrictSemver(version: string): boolean {
  return STRICT_SEMVER.test(version);
}

/** Whether `candidate` is a later semver release, including prerelease precedence. */
function isNewer(candidate: string, current: string): boolean {
  const next = parseRuntimeVersion(candidate);
  const now = parseRuntimeVersion(current);
  if (!next || !now) return false;
  const order = compareVersions(next, now);
  if (order !== 0) return order > 0;
  const prerelease = (version: string) => version.includes("-") ? version.slice(version.indexOf("-") + 1).split(".") : [];
  const left = prerelease(candidate);
  const right = prerelease(current);
  if (!left.length || !right.length) return Boolean(right.length && !left.length);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a !== undefined;
    if (a === b) continue;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric !== bNumeric) return !aNumeric;
    // Compare numeric identifiers without losing precision on long digit strings.
    return aNumeric && a.length !== b.length ? a.length > b.length : a > b;
  }
  return false;
}

/** Why the engine would refuse to run `version`, in the same terms as the check it runs. */
function incompatibility(provider: ManagedProvider, version: string, minimumVersion?: string): string | undefined {
  if (provider === "codex") return codexVersionIncompatibility(version, minimumVersion ?? CODEX_PROTOCOL_VERSION);
  const tooOld = checkMinimumVersion(version, minimumVersion ?? CLAUDE_CODE_MIN_VERSION);
  return tooOld ? `Claude Code ${version} is too old: ${tooOld}` : undefined;
}

/** The real host: this machine and the network. */
const REAL_HOST: RuntimeHost = {
  platform: process.platform,
  exec: (command, args, options) =>
    new Promise((done) => {
      execFile(command, [...args], { env: options.env as NodeJS.ProcessEnv, cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error: ExecFileException | null, stdout, stderr) => {
        if (!error) return done({ exitCode: 0, stdout, stderr });
        if (error.killed) return done({ exitCode: null, stdout, stderr, error: `it timed out after ${options.timeoutMs} ms` });
        // A normal non-zero exit says what it has to say in stdout and stderr.
        if (typeof error.code === "number") return done({ exitCode: error.code, stdout, stderr });
        done({ exitCode: null, stdout, stderr, error: error.message });
      });
    }),
  fetch: (url, init) => fetch(url, init),
  realpath: (path) => realpath(path),
  isExecutable: async (path) => {
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  readText: async (path) => {
    const file = await open(path, "r").catch(() => undefined);
    if (!file) return undefined;
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(MAX_SHIM_BYTES), 0, MAX_SHIM_BYTES, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } catch {
      return undefined;
    } finally {
      await file.close();
    }
  },
  bundledClaude: readBundledClaude,
  claudeSession: (binary, env) => claudeSessionVersion(sdkQuery, binary, env),
};

/**
 * Opens an Agent SDK session on `binary` and returns the version it reports. The
 * prompt stream stays empty and the session closes once it has initialised, so
 * no model is called. No tools, MCP servers or settings load, and nothing is saved.
 */
export async function claudeSessionVersion(query: typeof sdkQuery, binary: string, env: Env): Promise<string | undefined> {
  let closeInput = () => {};
  const closed = new Promise<void>((done) => (closeInput = done));
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await closed;
  })();
  const session = query({
    prompt,
    options: { cwd: tmpdir(), env: { ...env }, pathToClaudeCodeExecutable: binary, settingSources: [], tools: [], strictMcpConfig: true, mcpServers: {}, persistSession: false },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = await Promise.race([
      session.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AgentEngineError("it did not initialise in time")), SESSION_TIMEOUT_MS);
      }),
    ]);
    return init.claude_code_version;
  } finally {
    clearTimeout(timer);
    closeInput();
    session.close();
  }
}

/** Reads the installed Agent SDK's pairing and finds its binary the way the SDK does. */
async function readBundledClaude(): Promise<BundledClaude | undefined> {
  try {
    const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    const manifest = JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8")) as { version?: unknown; claudeCodeVersion?: unknown };
    if (typeof manifest.version !== "string" || typeof manifest.claudeCodeVersion !== "string") return undefined;
    const suffix = process.platform === "win32" ? ".exe" : "";
    const platforms = process.platform === "linux" ? [`linux-${process.arch}`, `linux-${process.arch}-musl`] : [`${process.platform}-${process.arch}`];
    const sdkRequire = createRequire(entry);
    for (const platform of platforms) {
      try {
        return { sdkVersion: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion, path: sdkRequire.resolve(`${SDK_PACKAGE}-${platform}/claude${suffix}`) };
      } catch {
        // Only this platform's package is installed.
      }
    }
    return { sdkVersion: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion };
  } catch {
    return undefined;
  }
}

/** The environment with folders put first on PATH, so `#!/usr/bin/env node` finds the node that belongs to them. */
function withPath(env: Env, ...folders: string[]): Env {
  return { ...env, PATH: [...folders, env.PATH].filter(Boolean).join(delimiter) };
}

/** Finds a command the way spawning it would: a path as given, a bare name on PATH. */
async function locate(command: string, env: Env, host: RuntimeHost): Promise<string | undefined> {
  if (command.includes("/") || (host.platform === "win32" && command.includes("\\"))) {
    const path = resolve(command);
    return (await host.isExecutable(path)) ? path : undefined;
  }
  const names = host.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  for (const folder of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const path = resolve(folder, name);
      if (await host.isExecutable(path)) return path;
    }
  }
  return undefined;
}

/** Runs `<binary> --version`. A failure is an answer, not an exception. */
async function readVersion(binary: string, name: string, env: Env, host: RuntimeHost): Promise<{ version?: string; problem?: string }> {
  // Outside any project: pnpm switches to the version a `packageManager` field in the current folder names.
  const result = await host.exec(binary, ["--version"], { env: withPath(env, dirname(binary)), cwd: tmpdir(), timeoutMs: VERSION_TIMEOUT_MS });
  // OpenCode prints `v2.2.7`, so a leading `v` is allowed.
  const version = result.exitCode === 0 ? result.stdout.match(/(?<![\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u)?.[1] : undefined;
  if (version) return { version };
  const detail = result.error ?? (`${result.stderr}${result.stdout}`.trim().split("\n").at(-1) || `it exited with code ${result.exitCode}`);
  return { problem: `The ${name} version could not be read: ${detail}` };
}

/** Fetches a fixed URL with a timeout, and nothing but an accept header. Any failure means "unknown": being offline is normal. */
async function fetchBody<T>(url: string, accept: string, timeoutMs: number, host: RuntimeHost, read: (response: { json(): Promise<unknown>; text(): Promise<string> }) => Promise<T>): Promise<T | undefined> {
  try {
    const response = await host.fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept } });
    return response.ok ? await read(response) : undefined;
  } catch {
    return undefined;
  }
}

/** Fetches a registry document. */
async function fetchDocument(url: string, timeoutMs: number, host: RuntimeHost): Promise<Record<string, unknown> | undefined> {
  const body = await fetchBody(url, "application/json", timeoutMs, host, (response) => response.json());
  return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
}

/** What has been published, from the channel the owner installs from. */
interface Published {
  latest?: string;
  sdkLatest?: string;
}

/** A version from a document, if it is one this library would pass to an installer. */
function strict(value: unknown): string | undefined {
  return typeof value === "string" && isStrictSemver(value) ? value : undefined;
}

/** Looks up a package's `latest` tag on npm. */
async function npmLatest(packageName: string, timeoutMs: number, host: RuntimeHost): Promise<Published> {
  const document = await fetchDocument(`https://registry.npmjs.org/${packageName}/latest`, timeoutMs, host);
  return { latest: strict(document?.version) };
}

/** Looks up the Claude Code the latest Agent SDK pairs with. */
async function sdkLatest(timeoutMs: number, host: RuntimeHost): Promise<Published> {
  const document = await fetchDocument(`https://registry.npmjs.org/${SDK_PACKAGE}/latest`, timeoutMs, host);
  return { latest: strict(document?.claudeCodeVersion), sdkLatest: strict(document?.version) };
}

/** Looks up a Homebrew cask. It trails npm, and its own channel is what `brew upgrade` can reach. */
async function caskLatest(token: string, timeoutMs: number, host: RuntimeHost): Promise<Published> {
  const document = await fetchDocument(`https://formulae.brew.sh/api/cask/${token}.json`, timeoutMs, host);
  return { latest: strict(document?.version) };
}

/** One command an update runs. */
interface Command {
  argv: readonly string[];
  env: Env;
}

/** How to move a runtime. `version` is passed only when `canPin` is true. */
interface Installer {
  /** Stable install location, shared by aliases and versioned binaries. */
  location: string;
  canPin: boolean;
  command(version: string): Command;
}

/** What is known about who owns a binary. */
interface Owner {
  managedBy: RuntimeManager;
  /** Absent when there is no installer to run; `blocked` says why. */
  installer?: Installer;
  blocked?: string;
  lookup(timeoutMs: number): Promise<Published>;
}

/** The binary a runtime check found, and what it found out. */
interface Inspection {
  installed: boolean;
  binary?: string;
  path?: string;
  version?: string;
  versionProblem?: string;
  owner: Owner;
  bundled?: BundledClaude;
}

/**
 * Finds a package manager: the one in the install's own folder if there is one,
 * else any on PATH. A prefix need not hold an npm of its own, and the owner's
 * location is pinned by flags and environment either way.
 */
async function ownTool(name: string, candidates: readonly string[], env: Env, host: RuntimeHost): Promise<string | undefined> {
  for (const candidate of candidates) if (await host.isExecutable(candidate)) return candidate;
  return locate(name, env, host);
}

/** A global install under an npm prefix. `--prefix` pins it: npm otherwise installs to the prefix of whichever node runs it. */
async function npmOwner(spec: Spec, prefix: string, lookup: Owner["lookup"], env: Env, host: RuntimeHost): Promise<Owner> {
  const npm = await ownTool("npm", [join(prefix, "bin", "npm")], env, host);
  if (!npm) return { managedBy: "npm", lookup, blocked: `${spec.name} is an npm global under ${prefix}, but npm was not found to update it.` };
  return {
    managedBy: "npm",
    lookup,
    installer: {
      location: prefix,
      canPin: true,
      command: (version) => ({
        argv: [npm, "install", "--global", "--prefix", prefix, "--no-fund", "--no-audit", "--no-update-notifier", ...(spec.installScript ? [`--allow-scripts=${spec.package}`] : []), `${spec.package}@${version}`],
        env: withPath(env, join(prefix, "bin")),
      }),
    },
  };
}

/** A global install under `PNPM_HOME`. pnpm refuses to run unless its bin folder is on PATH; that folder is `bin` from pnpm 11 and the home itself before. */
async function pnpmOwner(spec: Spec, home: string, bin: string, lookup: Owner["lookup"], env: Env, host: RuntimeHost): Promise<Owner> {
  const pnpm = await ownTool("pnpm", [join(home, "bin", "pnpm"), join(home, "pnpm")], env, host);
  if (!pnpm) return { managedBy: "pnpm", lookup, blocked: `${spec.name} is a pnpm global under ${home}, but pnpm was not found to update it.` };
  const { version: pnpmVersion } = await readVersion(pnpm, "pnpm", env, host);
  const parsed = pnpmVersion ? parseRuntimeVersion(pnpmVersion) : undefined;
  const olderThan = (minimum: readonly [number, number, number]) => Boolean(parsed && compareVersions(parsed, minimum) < 0);
  // `--allow-build` came in pnpm 10.4, and before it the install script cannot be allowed for one command.
  if (spec.installScript && olderThan([10, 4, 0])) {
    return { managedBy: "pnpm", lookup, blocked: `Updating ${spec.name} takes pnpm 10.4 or newer, to allow its install script, and this pnpm is ${pnpmVersion}. Update pnpm first.` };
  }
  // pnpm 12 refuses `--global-bin-dir` and reads the folder from its environment instead.
  const binFlag = olderThan([12, 0, 0]);
  return {
    managedBy: "pnpm",
    lookup,
    installer: {
      location: home,
      canPin: true,
      command: (version) => ({
        argv: [pnpm, "add", "--global", "--global-dir", join(home, "global"), ...(binFlag ? ["--global-bin-dir", bin] : []), ...(spec.installScript ? [`--allow-build=${spec.package}`] : []), `${spec.package}@${version}`],
        env: { ...withPath(env, join(home, "bin"), home), PNPM_HOME: home, ...(binFlag ? {} : { PNPM_CONFIG_GLOBAL_BIN_DIR: bin, pnpm_config_global_bin_dir: bin }) },
      }),
    },
  };
}

/** A global install under `BUN_INSTALL`. */
async function bunOwner(spec: Spec, root: string, lookup: Owner["lookup"], env: Env, host: RuntimeHost): Promise<Owner> {
  const bun = await ownTool("bun", [join(root, "bin", "bun")], env, host);
  if (!bun) return { managedBy: "bun", lookup, blocked: `${spec.name} is a bun global under ${root}, but bun was not found to update it.` };
  return {
    managedBy: "bun",
    lookup,
    installer: {
      location: root,
      canPin: true,
      command: (version) => ({
        argv: [bun, "add", "--global", ...(spec.installScript ? ["--trust"] : []), `${spec.package}@${version}`],
        env: { ...withPath(env, join(root, "bin")), BUN_INSTALL: root, BUN_INSTALL_GLOBAL_DIR: join(root, "install", "global"), BUN_INSTALL_BIN: join(root, "bin") },
      }),
    },
  };
}

/** A Homebrew install. Casks can only go to their latest, and a cask name must be one this library knows before it reaches a command or URL. */
async function homebrewOwner(spec: Spec, root: string, room: string, name: string, npmLookup: Owner["lookup"], env: Env, host: RuntimeHost): Promise<Owner> {
  if (room !== "Caskroom" || !(spec.casks as readonly string[]).includes(name)) {
    return { managedBy: "homebrew", lookup: npmLookup, blocked: `${spec.name} is in Homebrew as ${name}, which this library does not manage. Update it with brew.` };
  }
  const lookup: Owner["lookup"] = (timeoutMs) => caskLatest(name, timeoutMs, host);
  const brew = join(root, "bin", "brew");
  if (!(await host.isExecutable(brew))) return { managedBy: "homebrew", lookup, blocked: `${spec.name} is a Homebrew cask, but ${brew} was not found to update it.` };
  return {
    managedBy: "homebrew",
    lookup,
    installer: { location: join(root, "Caskroom", name), canPin: false, command: () => ({ argv: [brew, "upgrade", "--cask", name], env: withPath(env, join(root, "bin")) }) },
  };
}

/** Reads the owner from where the binary really lives. Order matters: a Homebrew formula keeps its own `lib/node_modules`. */
async function detectOwner(provider: ManagedProvider, binary: string, path: string, env: Env, host: RuntimeHost): Promise<Owner> {
  const spec = SPECS[provider];
  const npmLookup: Owner["lookup"] = (timeoutMs) => npmLatest(spec.package, timeoutMs, host);
  const unmanaged = (blocked: string): Owner => ({ managedBy: "unknown", lookup: npmLookup, blocked });
  if (host.platform === "win32") return unmanaged(`Updating ${spec.name} is not supported on Windows. Update it the way you installed it.`);

  const homebrew = path.match(/^(.*)\/(Caskroom|Cellar)\/([^/]+)\//u);
  if (homebrew) return homebrewOwner(spec, homebrew[1], homebrew[2], homebrew[3], npmLookup, env, host);

  if (provider === "claude" && /\/claude-agent-sdk(-[^/]+)?\//u.test(path)) {
    return { managedBy: "bundled", lookup: (timeoutMs) => sdkLatest(timeoutMs, host), blocked: `This ${spec.name} is the copy inside the Claude Agent SDK. Moving it takes a new app release with a newer SDK.` };
  }

  // The binary can live in the package or in its platform package: bun links the latter straight into its bin folder.
  const inPackage = `node_modules/${spec.package}(?:-(?:darwin|linux|win32)-[a-z0-9-]+)?/`;
  const bun = path.match(new RegExp(`^(.+?)/install/global/${inPackage}`, "u"));
  if (bun) return bunOwner(spec, bun[1], npmLookup, env, host);

  const npm = path.match(new RegExp(`^(.*?)/lib/${inPackage}`, "u"));
  if (npm) return npmOwner(spec, npm[1] || "/", npmLookup, env, host);

  // pnpm's bin entries are scripts, not symlinks, so the path may stop at the script. Its text names the target.
  const pnpmTarget = new RegExp(`/global/([^/\\s"']+)/(?:[^\\s"']*/)?${inPackage}`, "u");
  const direct = path.match(pnpmTarget);
  if (direct) {
    const home = path.slice(0, direct.index);
    return pnpmOwner(spec, home, /^v\d+$/u.test(direct[1]) ? join(home, "bin") : home, npmLookup, env, host);
  }
  const shim = await host.readText(path);
  if (shim && pnpmTarget.test(shim)) {
    // Spelled as on PATH when only a parent folder is a symlink: pnpm compares its store location as text.
    const folder = (await host.realpath(dirname(binary)).catch(() => undefined)) === dirname(path) ? dirname(binary) : dirname(path);
    // From pnpm 11 the script sits in `<home>/bin` and points up at `../global`.
    return pnpmOwner(spec, shim.includes("/../global/") ? dirname(folder) : folder, folder, npmLookup, env, host);
  }

  const self = path.match(spec.selfManaged);
  if (self) {
    return {
      managedBy: "self",
      lookup: npmLookup,
      installer: {
        location: path.slice(0, self.index! + self[0].length),
        canPin: spec.selfPins,
        command: (version) => ({ argv: spec.selfCommand(binary, version), env: withPath(env, dirname(binary)) }),
      },
    };
  }
  if (path.includes("/node_modules/")) return unmanaged(`${spec.name} at ${path} is a project dependency. Update it in that project.`);
  return unmanaged(`Could not tell which installer owns ${path}. Update ${spec.name} the way you installed it.`);
}

/** Finds the binary an engine would run, and who owns it. */
async function inspect(provider: ManagedProvider, target: RuntimeTarget, host: RuntimeHost): Promise<Inspection> {
  const spec = SPECS[provider];
  const env = target.env ?? process.env;
  if (provider === "claude" && !target.executable) return inspectBundled(host);
  const command = target.executable ?? spec.command;
  const binary = await locate(command, env, host);
  if (!binary) {
    return {
      installed: false,
      owner: { managedBy: "unknown", lookup: (timeoutMs) => npmLatest(spec.package, timeoutMs, host), blocked: `${spec.name} is not installed: ${command} was not found.` },
    };
  }
  const path = await host.realpath(binary).catch(() => binary);
  const [read, owner] = await Promise.all([readVersion(binary, spec.name, env, host), detectOwner(provider, binary, path, env, host)]);
  return { installed: true, binary, path, version: read.version, versionProblem: read.problem, owner };
}

/** No `executable`: the SDK's own copy runs, and only a new release of the app can move it. */
async function inspectBundled(host: RuntimeHost): Promise<Inspection> {
  const bundled = await host.bundledClaude();
  const lookup: Owner["lookup"] = (timeoutMs) => sdkLatest(timeoutMs, host);
  if (!bundled) return { installed: false, owner: { managedBy: "bundled", lookup, blocked: "The Claude Agent SDK's package could not be read, so its bundled Claude Code is unknown." } };
  return {
    installed: Boolean(bundled.path),
    path: bundled.path,
    version: bundled.claudeCodeVersion,
    bundled,
    owner: { managedBy: "bundled", lookup, blocked: bundledReason(bundled) },
  };
}

/** Why a bundled Claude cannot be moved here. */
function bundledReason(bundled: BundledClaude, published: Published = {}): string {
  const missing = bundled.path ? "" : " Its binary for this platform is not installed.";
  const newer = published.sdkLatest && published.latest && isNewer(published.latest, bundled.claudeCodeVersion);
  const move = newer
    ? `Moving to ${published.latest} takes a new app release with Agent SDK ${published.sdkLatest}`
    : "Moving it takes a new app release with a newer SDK";
  return `This app runs the Claude Code ${bundled.claudeCodeVersion} inside Claude Agent SDK ${bundled.sdkVersion}. ${move}; \`claude update\` does not change it.${missing}`;
}

/** Fills in the real host for anything a caller did not replace. */
function hostFrom(replacement: Partial<RuntimeHost> | undefined): RuntimeHost {
  return { ...REAL_HOST, ...replacement };
}

/**
 * The `claude` on PATH, for an app that wants the install the terminal uses:
 * pass `path` as the engine's `executable`. Undefined when it is missing, does not
 * run or is older than the minimum, so the app can fall back to the bundled copy.
 * Give `env` a fuller PATH if the app starts with a thin one, as under launchd.
 */
export async function findSharedClaude(options: Pick<RuntimeTarget, "env" | "minimumVersion"> & Pick<RuntimeCheckOptions, "host"> = {}): Promise<SharedClaude | undefined> {
  const host = hostFrom(options.host);
  const env = options.env ?? process.env;
  const path = await locate(SPECS.claude.command, env, host);
  if (!path) return undefined;
  const { version } = await readVersion(path, SPECS.claude.name, env, host);
  if (!version || incompatibility("claude", version, options.minimumVersion)) return undefined;
  return { path, version };
}

/** The installed Agent SDK that drives Claude, whichever binary it runs. */
async function sdkReport(found: Inspection, latest: string | undefined, host: RuntimeHost): Promise<RuntimeVersionStatus["sdk"]> {
  const sdk = found.bundled ?? (await host.bundledClaude());
  return sdk ? { version: sdk.sdkVersion, claudeCode: sdk.claudeCodeVersion, latest } : undefined;
}

/**
 * Reports a runtime's status without starting a turn or an app-server. The only
 * processes it starts are `<binary> --version` and, for a pnpm global, `pnpm --version`.
 * A missing runtime or a failed lookup is a field in the result, not an exception.
 */
export async function runtimeVersion(provider: ManagedProvider, options: RuntimeTarget & RuntimeCheckOptions = {}): Promise<RuntimeVersionStatus> {
  const host = hostFrom(options.host);
  const spec = SPECS[provider];
  const found = await inspect(provider, options, host);
  const timeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  // A bundled Claude's own lookup already reads the SDK's latest.
  const [published, sdkPublished] = await Promise.all([found.owner.lookup(timeoutMs), provider === "claude" && found.owner.managedBy !== "bundled" ? sdkLatest(timeoutMs, host) : undefined]);
  const { version } = found;
  const { latest } = published;
  const installedProblem = version ? incompatibility(provider, version, options.minimumVersion) : undefined;
  const latestProblem = latest ? incompatibility(provider, latest, options.minimumVersion) : undefined;
  const newerAvailable = Boolean(latest && version && isNewer(latest, version));
  const installer = found.owner.installer;
  // An install that cannot say its version is broken, and an update is the way to repair it.
  const updateOffered = Boolean(installer && latest && !latestProblem && (newerAvailable || found.versionProblem));
  const blocked = found.bundled ? bundledReason(found.bundled, published) : found.owner.blocked;

  let reason: string | undefined;
  if (blocked) reason = blocked;
  else if (found.versionProblem) reason = found.versionProblem;
  else if (!latest) reason = `The latest ${spec.name} version could not be looked up.`;
  else if (latestProblem && (newerAvailable || !version)) reason = `${spec.name} ${latest} is not offered because this library would refuse to run it: ${latestProblem}`;

  return {
    provider,
    installed: found.installed,
    version,
    latest,
    path: found.path,
    managedBy: found.owner.managedBy,
    compatible: version ? !installedProblem : undefined,
    incompatibility: installedProblem,
    latestCompatible: latest ? !latestProblem : undefined,
    latestIncompatibility: latestProblem,
    newerAvailable,
    canUpdate: Boolean(installer),
    canPinVersion: Boolean(installer?.canPin),
    updateOffered,
    updateCommand: installer && latest ? installer.command(latest).argv : undefined,
    reason,
    sdk: provider === "claude" ? await sdkReport(found, (sdkPublished ?? published).sdkLatest, host) : undefined,
    checkedAt: new Date(),
  };
}

/** Install locations with an update running in this process. Aliases share one lock. */
const updating = new Set<string>();

/**
 * Moves a runtime with the installer that owns it, to the latest version or to
 * `options.version`, then reads the version back and rechecks compatibility.
 * Throws `RuntimeUpdateError` for everything short of a verified result.
 */
export async function updateRuntime(provider: ManagedProvider, options: RuntimeTarget & RuntimeUpdateOptions = {}): Promise<RuntimeUpdateResult> {
  const requested = options.version;
  if (requested !== undefined && !isStrictSemver(requested)) {
    throw new RuntimeUpdateError("invalid-version", `${JSON.stringify(requested)} is not a strict semver version such as 1.2.3.`);
  }
  const host = hostFrom(options.host);
  const spec = SPECS[provider];
  const found = await inspect(provider, options, host);
  const { binary, version: from, owner } = found;
  const { installer } = owner;
  if (!installer || !binary) throw new RuntimeUpdateError("not-updatable", owner.blocked ?? `${spec.name} cannot be updated here.`, { from, target: requested });
  if (requested && !installer.canPin) {
    const updater = owner.managedBy === "homebrew" ? "Homebrew" : `${spec.name}'s own updater`;
    throw new RuntimeUpdateError("not-updatable", `${updater} can only move ${spec.name} to its latest version, not to ${requested}.`, { from, target: requested });
  }

  const target = requested ?? (await owner.lookup(options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS)).latest;
  if (!target) throw new RuntimeUpdateError("lookup-failed", `The latest ${spec.name} version could not be looked up, so whether this library could run it is unknown.`, { from });
  const refused = incompatibility(provider, target, options.minimumVersion);
  if (refused) throw new RuntimeUpdateError("incompatible-target", `${spec.name} ${target} was not installed because this library would refuse to run it: ${refused}`, { from, target });
  if (from && (from === target || (!requested && !isNewer(target, from)))) {
    return { provider, outcome: "up-to-date", from, to: from, managedBy: owner.managedBy, path: found.path ?? binary };
  }

  const location = await host.realpath(installer.location).catch(() => installer.location);
  const lock = `${owner.managedBy}:${location}`;
  if (updating.has(lock)) throw new RuntimeUpdateError("in-progress", `An update of ${binary} is already running.`, { from, target });
  updating.add(lock);
  try {
    const { argv, env } = installer.command(target);
    const ran = await host.exec(argv[0], argv.slice(1), { env, cwd: tmpdir(), timeoutMs: options.timeoutMs ?? UPDATE_TIMEOUT_MS });
    return await verifyUpdate(provider, { binary, from, target, pinned: installer.canPin, argv, ran, owner }, options, host);
  } finally {
    updating.delete(lock);
  }
}

/** Reads the version back and decides how the update ended. A failed installer may still have changed the binary, so `to` is read either way. */
async function verifyUpdate(
  provider: ManagedProvider,
  update: { binary: string; from?: string; target: string; pinned: boolean; argv: readonly string[]; ran: RuntimeExecResult; owner: Owner },
  options: RuntimeTarget,
  host: RuntimeHost,
): Promise<RuntimeUpdateResult> {
  const { binary, from, target, pinned, argv, ran, owner } = update;
  const spec = SPECS[provider];
  const output = `${ran.stdout}${ran.stderr}`.slice(-MAX_OUTPUT_CHARS);
  const read = await readVersion(binary, spec.name, options.env ?? process.env, host);
  const to = read.version;
  const details = { from, to, target, exitCode: ran.exitCode, output, command: argv };
  if (ran.error || ran.exitCode !== 0) {
    throw new RuntimeUpdateError("installer-failed", `Updating ${spec.name} with ${owner.managedBy} failed: ${ran.error ?? `it exited with code ${ran.exitCode}`}. It now reports ${to ?? "no version"}.`, details);
  }
  if (!to) throw new RuntimeUpdateError("version-mismatch", `The installer finished, but ${read.problem ?? `${spec.name} reports no version`}.`, details);
  if (pinned ? to !== target : to !== target && !isNewer(to, target)) {
    throw new RuntimeUpdateError("version-mismatch", `The installer finished, but ${spec.name} reports ${to} and not ${pinned ? target : `${target} or newer`}.`, details);
  }
  const refused = incompatibility(provider, to, options.minimumVersion);
  if (refused) throw new RuntimeUpdateError("incompatible-result", `${spec.name} is now ${to}, which this library would refuse to run: ${refused}`, details);
  if (provider === "claude") await checkSdkSession(binary, to, options, host, details);
  return { provider, outcome: "updated", from, to, managedBy: owner.managedBy, path: await host.realpath(binary).catch(() => binary), command: argv, output };
}

/** The app runs Claude through the Agent SDK, not by `--version`, so the SDK has to accept the new binary too. */
async function checkSdkSession(binary: string, to: string, options: RuntimeTarget, host: RuntimeHost, details: ConstructorParameters<typeof RuntimeUpdateError>[2]): Promise<void> {
  let reported: string | undefined;
  try {
    reported = await host.claudeSession(binary, options.env ?? process.env);
  } catch (error) {
    throw new RuntimeUpdateError("sdk-check-failed", `Claude Code is now ${to}, but the Agent SDK could not open a session on it: ${error instanceof Error ? error.message : String(error)}`, details);
  }
  if (reported !== to) {
    throw new RuntimeUpdateError("sdk-check-failed", `Claude Code reports ${to}, but a session through the Agent SDK reports ${reported ?? "no version"}.`, details);
  }
}

/** A published text without its Markdown, for showing as it is or handing on. */
function plainText(markdown: string): string {
  return markdown
    .replace(/\r\n/gu, "\n")
    .replace(/^```.*\n?/gmu, "")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\*\*|`/gu, "")
    .trim();
}

/** Keeps the notes for versions after `from`, up to and including `to`, newest first. */
function notesBetween(notes: readonly RuntimeReleaseNote[], from: string, to: string): RuntimeReleaseNote[] {
  return notes
    .filter((note) => note.text && isNewer(note.version, from) && !isNewer(note.version, to))
    .sort((left, right) => (isNewer(left.version, right.version) ? -1 : isNewer(right.version, left.version) ? 1 : 0));
}

/** A GitHub repository whose releases are tagged `<prefix><version>`. */
interface GithubReleases {
  repo: string;
  tagPrefix: string;
}

const CODEX_RELEASES: GithubReleases = { repo: "openai/codex", tagPrefix: "rust-v" };
const OPENCODE_RELEASES: GithubReleases = { repo: "anomalyco/opencode", tagPrefix: "v" };

/** Fetches one GitHub API document. */
function githubJson(repo: string, path: string, timeoutMs: number, host: RuntimeHost): Promise<unknown> {
  return fetchBody(`https://api.github.com/repos/${repo}/${path}`, "application/vnd.github+json", timeoutMs, host, (response) => response.json());
}

/**
 * Which versions to read notes for: the release tags in the range, with `to`
 * always among them. The tags are read minor by minor, because the list of
 * releases carries every release's assets and runs to tens of megabytes a page.
 */
async function taggedVersionsBetween(releases: GithubReleases, from: string, to: string, timeoutMs: number, host: RuntimeHost): Promise<string[]> {
  const [fromMajor, fromMinor] = parseRuntimeVersion(from) as readonly [number, number, number];
  const [toMajor, toMinor] = parseRuntimeVersion(to) as readonly [number, number, number];
  if (fromMajor !== toMajor) return [to];
  const { repo, tagPrefix } = releases;
  const minors = Array.from({ length: Math.min(toMinor - fromMinor + 1, MAX_NOTES_MINORS) }, (_, index) => toMinor - index);
  const lists = await Promise.all(minors.map((minor) => githubJson(repo, `git/matching-refs/tags/${tagPrefix}${toMajor}.${minor}.?per_page=100`, timeoutMs, host)));
  const tagged = lists.flatMap((refs) => (Array.isArray(refs) ? (refs as Array<{ ref?: unknown } | null>) : []))
    .map((entry) => (typeof entry?.ref === "string" && entry.ref.startsWith(`refs/tags/${tagPrefix}`) ? strict(entry.ref.slice(`refs/tags/${tagPrefix}`.length)) : undefined))
    .filter((version): version is string => version !== undefined && !version.includes("-"));
  return [...new Set([to, ...tagged])].filter((version) => isNewer(version, from) && !isNewer(version, to));
}

/** A project's GitHub releases. Prereleases are skipped unless one is what the update went to. */
async function githubNotes(releases: GithubReleases, from: string, to: string, timeoutMs: number, host: RuntimeHost): Promise<RuntimeReleaseNote[]> {
  const versions = await taggedVersionsBetween(releases, from, to, timeoutMs, host);
  const notes = await Promise.all(
    versions.map(async (version) => {
      const release = (await githubJson(releases.repo, `releases/tags/${releases.tagPrefix}${version}`, timeoutMs, host)) as { body?: unknown; draft?: unknown } | null | undefined;
      return typeof release?.body === "string" && release.draft !== true ? { version, text: plainText(release.body) } : undefined;
    }),
  );
  return notes.filter((note) => note !== undefined);
}

/** The sections of Claude Code's changelog. Not every version has one. */
async function claudeNotes(timeoutMs: number, host: RuntimeHost): Promise<RuntimeReleaseNote[]> {
  const url = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
  const changelog = await fetchBody(url, "text/plain", timeoutMs, host, (response) => response.text());
  if (typeof changelog !== "string") return [];
  const notes: RuntimeReleaseNote[] = [];
  // `^## ` splits the file at each section; what comes before the first is the title.
  for (const section of changelog.replace(/\r\n/gu, "\n").split(/^(?=## )/mu)) {
    const heading = section.match(/^## (\S+).*\n?/u);
    const version = strict(heading?.[1]);
    if (heading && version) notes.push({ version, text: plainText(section.slice(heading[0].length)) });
  }
  return notes;
}

/**
 * What a project published for the versions after `from`, up to and including
 * `to`, newest first and one entry per version that has notes. Any failure, bad
 * version included, gives fewer notes or none, never an error: notes are a nicety.
 * Codex's and OpenCode's come from their GitHub releases, Claude Code's from its
 * changelog; Antigravity publishes none this library can read.
 * Unsummarised, and text from outside: treat it as data, not instructions.
 */
export async function runtimeReleaseNotes(provider: ManagedProvider | AcpUpdater, options: { from: string; to: string; timeoutMs?: number; host?: Partial<RuntimeHost> }): Promise<RuntimeReleaseNote[]> {
  const { from, to } = options;
  if (!isStrictSemver(from) || !isStrictSemver(to) || !isNewer(to, from)) return [];
  const host = hostFrom(options.host);
  const timeoutMs = options.timeoutMs ?? NOTES_TIMEOUT_MS;
  if (provider === "antigravity") return [];
  const notes =
    provider === "codex" ? await githubNotes(CODEX_RELEASES, from, to, timeoutMs, host)
    : provider === "opencode" ? await githubNotes(OPENCODE_RELEASES, from, to, timeoutMs, host)
    : await claudeNotes(timeoutMs, host);
  return notesBetween(notes, from, to);
}

/** ACP agents whose own updater this library can drive. */
export type AcpUpdater = "opencode" | "antigravity";

/** How one ACP agent's own updater is asked what's new and told to move. */
interface AcpSpec {
  name: string;
  /** The newest version this install's updater would go to. */
  lookup(managedBy: RuntimeManager, version: string | undefined, timeoutMs: number, host: RuntimeHost): Promise<string | undefined>;
  /** The update command. `version` is passed on only when `canPin` says the updater honours it. */
  command(binary: string, version: string, managedBy: RuntimeManager): readonly string[];
  canPin(managedBy: RuntimeManager): boolean;
  /** Why this install can't be moved by the agent's own updater, if it can't. */
  blocked?(managedBy: RuntimeManager): string | undefined;
}

const ACP_SPECS: Record<AcpUpdater, AcpSpec> = {
  opencode: {
    name: "OpenCode",
    // The service `opencode upgrade` asks. A Homebrew install is answered with its tap's version.
    lookup: async (managedBy, version, timeoutMs, host) => {
      const channel = managedBy === "homebrew" ? "homebrew" : "npm";
      const document = await fetchDocument(`https://opencode.ai/update/api/latest/cli/${channel}?current=${encodeURIComponent(version ?? "0.0.0")}`, timeoutMs, host);
      return strict(document?.version);
    },
    // `opencode upgrade` finds its own installer: npm, pnpm, bun, its curl script or Homebrew.
    command: (binary, version, managedBy) => (managedBy === "homebrew" ? [binary, "upgrade"] : [binary, "upgrade", version]),
    // Homebrew goes only to its formula's latest.
    canPin: (managedBy) => managedBy !== "homebrew",
  },
  antigravity: {
    name: "Antigravity",
    // The CLI's own update server says its stable version on its front page.
    lookup: async (_managedBy, _version, timeoutMs, host) => {
      const page = await fetchBody("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/", "text/plain", timeoutMs, host, (response) => response.text());
      const found = typeof page === "string" ? page.match(/Stable Version:\s*(\S+)/u)?.[1]?.replace(/\.+$/u, "") : undefined;
      return strict(found);
    },
    command: (binary) => [binary, "update"],
    canPin: () => false,
    blocked: (managedBy) => (managedBy === "homebrew" ? "Antigravity is installed with Homebrew. Update it with brew." : undefined),
  },
};

/** Who owns an ACP agent's binary, as far as its own updater cares. */
const acpOwner = (path: string): RuntimeManager => (/\/(Caskroom|Cellar)\//u.test(path) ? "homebrew" : "self");

/** Finds an ACP agent's binary, its version and who owns it. */
async function inspectAcp(spec: AcpSpec, command: string, env: Env, host: RuntimeHost) {
  const binary = await locate(command, env, host);
  if (!binary) return undefined;
  const path = await host.realpath(binary).catch(() => binary);
  const read = await readVersion(binary, spec.name, env, host);
  const managedBy = acpOwner(path);
  return { binary, path, managedBy, version: read.version, versionProblem: read.problem, blocked: spec.blocked?.(managedBy) };
}

/**
 * The status of an ACP agent. Without an `updater` the protocol says nothing about
 * installers, so this only says whether its command is there, and `version` is what a
 * running agent reported. With one, the agent's own `--version` and update service
 * answer, and `updateRuntime` runs its own updater.
 */
export async function acpRuntimeVersion(name: string, command: string, version: string | undefined, options: { env?: Env; updater?: AcpUpdater } & RuntimeCheckOptions = {}): Promise<RuntimeVersionStatus> {
  const host = hostFrom(options.host);
  if (options.updater) return acpManagedVersion(ACP_SPECS[options.updater], command, options, host);
  const binary = await locate(command, options.env ?? process.env, host);
  return {
    provider: "acp",
    installed: Boolean(binary),
    version,
    path: binary ? await host.realpath(binary).catch(() => binary) : undefined,
    managedBy: "unknown",
    newerAvailable: false,
    canUpdate: false,
    canPinVersion: false,
    updateOffered: false,
    reason: `This library cannot check or update ACP agents. Update ${name} the way you installed it.`,
    checkedAt: new Date(),
  };
}

/** An ACP agent's status from its own `--version` and update service. */
async function acpManagedVersion(spec: AcpSpec, command: string, options: { env?: Env } & RuntimeCheckOptions, host: RuntimeHost): Promise<RuntimeVersionStatus> {
  const found = await inspectAcp(spec, command, options.env ?? process.env, host);
  const base = { provider: "acp" as const, checkedAt: new Date() };
  if (!found) {
    return { ...base, installed: false, managedBy: "unknown", newerAvailable: false, canUpdate: false, canPinVersion: false, updateOffered: false, reason: `${spec.name} is not installed: ${command} was not found.` };
  }
  const { binary, path, managedBy, version, versionProblem, blocked } = found;
  const latest = await spec.lookup(managedBy, version, options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, host);
  const newerAvailable = Boolean(latest && version && isNewer(latest, version));
  const canUpdate = !blocked;
  let reason: string | undefined;
  if (blocked) reason = blocked;
  else if (versionProblem) reason = versionProblem;
  else if (!latest) reason = `The latest ${spec.name} version could not be looked up.`;
  return {
    ...base,
    installed: true,
    version,
    latest,
    path,
    managedBy,
    newerAvailable,
    canUpdate,
    canPinVersion: canUpdate && spec.canPin(managedBy),
    updateOffered: Boolean(canUpdate && latest && (newerAvailable || versionProblem)),
    updateCommand: canUpdate && latest ? spec.command(binary, latest, managedBy) : undefined,
    reason,
  };
}

/**
 * Moves an ACP agent with its own updater, to the latest version or to
 * `options.version` where the updater can pin one, then reads the version back.
 * Throws `RuntimeUpdateError` for everything short of a verified result.
 */
export async function acpUpdateRuntime(updater: AcpUpdater, command: string, options: { env?: Env } & RuntimeUpdateOptions = {}): Promise<RuntimeUpdateResult> {
  const requested = options.version;
  if (requested !== undefined && !isStrictSemver(requested)) {
    throw new RuntimeUpdateError("invalid-version", `${JSON.stringify(requested)} is not a strict semver version such as 1.2.3.`);
  }
  const host = hostFrom(options.host);
  const spec = ACP_SPECS[updater];
  const env = options.env ?? process.env;
  const found = await inspectAcp(spec, command, env, host);
  if (!found) throw new RuntimeUpdateError("not-updatable", `${spec.name} is not installed: ${command} was not found.`, { target: requested });
  const { binary, path, managedBy, version: from, blocked } = found;
  if (blocked) throw new RuntimeUpdateError("not-updatable", blocked, { from, target: requested });
  const pins = spec.canPin(managedBy);
  if (requested && !pins) {
    const owner = managedBy === "homebrew" ? "Homebrew" : `${spec.name}'s own updater`;
    throw new RuntimeUpdateError("not-updatable", `${owner} can only move ${spec.name} to its latest version, not to ${requested}.`, { from, target: requested });
  }
  const target = requested ?? (await spec.lookup(managedBy, from, options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, host));
  if (!target) throw new RuntimeUpdateError("lookup-failed", `The latest ${spec.name} version could not be looked up.`, { from });
  if (from && (from === target || (!requested && !isNewer(target, from)))) {
    return { provider: "acp", outcome: "up-to-date", from, to: from, managedBy, path };
  }

  const lock = `acp:${updater}:${path}`;
  if (updating.has(lock)) throw new RuntimeUpdateError("in-progress", `An update of ${binary} is already running.`, { from, target });
  updating.add(lock);
  try {
    const argv = spec.command(binary, target, managedBy);
    const ran = await host.exec(argv[0], argv.slice(1), { env: withPath(env, dirname(binary)), cwd: tmpdir(), timeoutMs: options.timeoutMs ?? UPDATE_TIMEOUT_MS });
    const output = `${ran.stdout}${ran.stderr}`.slice(-MAX_OUTPUT_CHARS);
    const read = await readVersion(binary, spec.name, env, host);
    const to = read.version;
    const details = { from, to, target, exitCode: ran.exitCode, output, command: argv };
    if (ran.error || ran.exitCode !== 0) {
      throw new RuntimeUpdateError("installer-failed", `Updating ${spec.name} failed: ${ran.error ?? `it exited with code ${ran.exitCode}`}. It now reports ${to ?? "no version"}.`, details);
    }
    if (!to) throw new RuntimeUpdateError("version-mismatch", `The updater finished, but ${read.problem ?? `${spec.name} reports no version`}.`, details);
    if (pins ? to !== target : to !== target && !isNewer(to, target)) {
      throw new RuntimeUpdateError("version-mismatch", `The updater finished, but ${spec.name} reports ${to} and not ${pins ? target : `${target} or newer`}.`, details);
    }
    return { provider: "acp", outcome: "updated", from, to, managedBy, path: await host.realpath(binary).catch(() => binary), command: argv, output };
  } finally {
    updating.delete(lock);
  }
}

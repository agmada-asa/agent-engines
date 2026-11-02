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

import { execFile, type ExecFileException } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { CODEX_PROTOCOL_VERSION, codexVersionIncompatibility } from "./codex/protocol/version.ts";
import { CLAUDE_CODE_MIN_VERSION, checkMinimumVersion, compareVersions, parseRuntimeVersion } from "./compat.ts";
import { RuntimeUpdateError } from "./errors.ts";
import type {
  BundledClaude,
  ProviderId,
  RuntimeCheckOptions,
  RuntimeExecResult,
  RuntimeHost,
  RuntimeManager,
  RuntimeUpdateOptions,
  RuntimeUpdateResult,
  RuntimeVersionStatus,
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

/** Whether `candidate` is a later release than `current`. A release beats its own prereleases. */
function isNewer(candidate: string, current: string): boolean {
  const next = parseRuntimeVersion(candidate);
  const now = parseRuntimeVersion(current);
  if (!next || !now) return false;
  const order = compareVersions(next, now);
  return order > 0 || (order === 0 && current.includes("-") && !candidate.includes("-"));
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
};

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
      const path = join(folder, name);
      if (await host.isExecutable(path)) return path;
    }
  }
  return undefined;
}

/** Runs `<binary> --version`. A failure is an answer, not an exception. */
async function readVersion(binary: string, name: string, env: Env, host: RuntimeHost): Promise<{ version?: string; problem?: string }> {
  const result = await host.exec(binary, ["--version"], { env: withPath(env, dirname(binary)), timeoutMs: VERSION_TIMEOUT_MS });
  const version = result.exitCode === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)?.[0] : undefined;
  if (version) return { version };
  const detail = result.error ?? (`${result.stderr}${result.stdout}`.trim().split("\n").at(-1) || `it exited with code ${result.exitCode}`);
  return { problem: `The ${name} version could not be read: ${detail}` };
}

/** Fetches a registry document. Any failure means "unknown": being offline is normal. */
async function fetchDocument(url: string, timeoutMs: number, host: RuntimeHost): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await host.fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const body = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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
      canPin: true,
      command: (version) => ({
        argv: [npm, "install", "--global", "--prefix", prefix, "--no-fund", "--no-audit", "--no-update-notifier", ...(spec.installScript ? [`--allow-scripts=${spec.package}`] : []), `${spec.package}@${version}`],
        env: withPath(env, join(prefix, "bin")),
      }),
    },
  };
}

/** A global install under `PNPM_HOME`. pnpm refuses to run unless its bin folder is on PATH; that folder is `bin` from pnpm 11 and the home itself before. */
async function pnpmOwner(spec: Spec, home: string, lookup: Owner["lookup"], env: Env, host: RuntimeHost): Promise<Owner> {
  const pnpm = await ownTool("pnpm", [join(home, "bin", "pnpm"), join(home, "pnpm")], env, host);
  if (!pnpm) return { managedBy: "pnpm", lookup, blocked: `${spec.name} is a pnpm global under ${home}, but pnpm was not found to update it.` };
  return {
    managedBy: "pnpm",
    lookup,
    installer: {
      canPin: true,
      command: (version) => ({
        argv: [pnpm, "add", "--global", ...(spec.installScript ? [`--allow-build=${spec.package}`] : []), `${spec.package}@${version}`],
        env: { ...withPath(env, join(home, "bin"), home), PNPM_HOME: home },
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
      canPin: true,
      command: (version) => ({
        argv: [bun, "add", "--global", ...(spec.installScript ? ["--trust"] : []), `${spec.package}@${version}`],
        env: { ...withPath(env, join(root, "bin")), BUN_INSTALL: root },
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
    installer: { canPin: false, command: () => ({ argv: [brew, "upgrade", "--cask", name], env: withPath(env, join(root, "bin")) }) },
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
  const pnpmTarget = new RegExp(`/global/[^/\\s"']+/(?:[^\\s"']*/)?${inPackage}`, "u");
  const direct = path.match(pnpmTarget);
  if (direct) return pnpmOwner(spec, path.slice(0, direct.index), npmLookup, env, host);
  const shim = await host.readText(path);
  if (shim && pnpmTarget.test(shim)) {
    // Spelled as on PATH when only a parent folder is a symlink: pnpm compares its store location as text.
    const folder = (await host.realpath(dirname(binary)).catch(() => undefined)) === dirname(path) ? dirname(binary) : dirname(path);
    // From pnpm 11 the script sits in `<home>/bin` and points up at `../global`.
    return pnpmOwner(spec, shim.includes("/../global/") ? dirname(folder) : folder, npmLookup, env, host);
  }

  if (spec.selfManaged.test(path)) {
    return {
      managedBy: "self",
      lookup: npmLookup,
      installer: {
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
 * Reports a runtime's status without starting a turn or an app-server. The only
 * process it starts is `<binary> --version`. A missing runtime or a failed lookup
 * is a field in the result, not an exception.
 */
export async function runtimeVersion(provider: ManagedProvider, options: RuntimeTarget & RuntimeCheckOptions = {}): Promise<RuntimeVersionStatus> {
  const host = hostFrom(options.host);
  const spec = SPECS[provider];
  const found = await inspect(provider, options, host);
  const published = await found.owner.lookup(options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
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
    sdk: found.bundled ? { version: found.bundled.sdkVersion, latest: published.sdkLatest } : undefined,
    checkedAt: new Date(),
  };
}

/** Binaries with an update running in this process. Two package manager runs over one install can break it. */
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

  if (updating.has(binary)) throw new RuntimeUpdateError("in-progress", `An update of ${binary} is already running.`, { from, target });
  updating.add(binary);
  try {
    const { argv, env } = installer.command(target);
    const ran = await host.exec(argv[0], argv.slice(1), { env, cwd: tmpdir(), timeoutMs: options.timeoutMs ?? UPDATE_TIMEOUT_MS });
    return await verifyUpdate(provider, { binary, from, target, pinned: installer.canPin, argv, ran, owner }, options, host);
  } finally {
    updating.delete(binary);
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
  if (pinned ? to !== target : to === from) {
    throw new RuntimeUpdateError("version-mismatch", `The installer finished, but ${spec.name} reports ${to} and not ${pinned ? target : `a newer version than ${from}`}.`, details);
  }
  const refused = incompatibility(provider, to, options.minimumVersion);
  if (refused) throw new RuntimeUpdateError("incompatible-result", `${spec.name} is now ${to}, which this library would refuse to run: ${refused}`, details);
  return { provider, outcome: "updated", from, to, managedBy: owner.managedBy, path: await host.realpath(binary).catch(() => binary), command: argv, output };
}

/**
 * The status of an ACP agent. The protocol has no notion of installers, so this
 * only says whether its command is there; `version` is what a running agent reported.
 */
export async function acpRuntimeVersion(name: string, command: string, version: string | undefined, options: { env?: Env } & RuntimeCheckOptions = {}): Promise<RuntimeVersionStatus> {
  const host = hostFrom(options.host);
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

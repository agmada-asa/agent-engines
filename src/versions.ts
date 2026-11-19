/**
 * @file Reading and comparing runtime versions: the minimum checks the engines
 * run before they use a runtime, and the ordering the updater uses to decide
 * whether a release is newer.
 */

import { CODEX_PROTOCOL_VERSION } from "./codex/protocol/version.ts";

/** `major.minor.patch[-prerelease]`, per semver.org. Build metadata means nothing to a registry, so it is refused too. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/u;

/** A whole version string, `major.minor.patch[-prerelease]`, with no text around it. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u;

/** Reads the first `major.minor.patch` triple from CLI version output. */
export function parseRuntimeVersion(output: string): readonly [number, number, number] | undefined {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Orders two version triples. */
export function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * Explains why `version` is older than `minimum`, or returns undefined when it
 * is recent enough. Compares the first `major.minor.patch` in each string.
 */
export function checkMinimumVersion(version: string, minimum: string): string | undefined {
  const parsed = parseRuntimeVersion(version);
  const floor = parseRuntimeVersion(minimum);
  if (!parsed || !floor) return `${version} is not a recognisable version`;
  return compareVersions(parsed, floor) < 0 ? `${minimum} or newer is required` : undefined;
}

/** Whether `version` is safe to pass to an installer. */
export function isStrictSemver(version: string): boolean {
  return STRICT_SEMVER.test(version);
}

/** Whether `candidate` is a later semver release, including prerelease precedence. */
export function isNewer(candidate: string, current: string): boolean {
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

/**
 * Explains why a serving Codex version cannot be used with bindings generated from `minimum`, or
 * returns undefined when it can.
 *
 * Codex ships frequent minor and patch releases that keep the app-server protocol this library
 * uses. Refusing each of them would stop every consumer on each update, so the pinned version is a
 * floor, not an exact match. Accepted: the same major version, at or above the minimum; real
 * protocol drift still fails visibly where it occurs, because the client rejects malformed
 * responses and mismatched results. Refused: an unparseable version, an older release (the
 * bindings may rely on newer fields), a prerelease of the minimum itself, or a different major
 * version (a deliberate breaking change).
 */
export function codexVersionIncompatibility(serving: string, minimum: string = CODEX_PROTOCOL_VERSION): string | undefined {
  const floor = EXACT_VERSION.test(minimum) ? parseRuntimeVersion(minimum) : undefined;
  const server = EXACT_VERSION.test(serving) ? parseRuntimeVersion(serving) : undefined;
  if (!floor) return `the minimum version ${minimum} is not a valid version`;
  if (!server) return `the serving version ${serving} is not a valid version`;
  if (server[0] !== floor[0]) {
    return `Codex ${serving} is a different major version from the generated bindings (${minimum}); regenerate and review them`;
  }
  const order = compareVersions(server, floor);
  if (order < 0) return `Codex ${serving} is older than the generated bindings require (${minimum} or newer)`;
  if (order === 0 && serving.includes("-") && !minimum.includes("-")) return `Codex ${serving} is a prerelease of the minimum version ${minimum}`;
  return undefined;
}

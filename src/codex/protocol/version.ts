/**
 * @file Records the Codex CLI version the checked-in protocol bindings were generated from and
 * decides which serving versions the transport accepts.
 *
 * Codex ships frequent minor and patch releases that keep the app-server protocol this library
 * uses. Refusing each of them would stop every consumer on each update, so the pinned version is a floor,
 * not an exact match. A newer release within the same major is used as is; real protocol drift
 * still fails visibly where it occurs, because the client rejects malformed responses and
 * mismatched results.
 */

/** Codex CLI/app-server version used to generate the checked-in bindings; the oldest accepted. */
export const CODEX_PROTOCOL_VERSION = "0.164.0";

/** Parsed `major.minor.patch[-prerelease]` version. */
interface ParsedVersion {
  core: readonly [number, number, number];
  prerelease: boolean;
}

/** Parses a semver-style version string; returns undefined for anything else. */
function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/u);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined };
}

/**
 * Explains why a serving Codex version cannot be used with bindings generated from `minimum`, or
 * returns undefined when it can. Accepted: the same major version, at or above the minimum.
 * Refused: an unparseable version, an older release (the bindings may rely on newer fields), a
 * prerelease of the minimum itself, or a different major version (a deliberate breaking change).
 */
export function codexVersionIncompatibility(serving: string, minimum: string = CODEX_PROTOCOL_VERSION): string | undefined {
  const server = parseVersion(serving);
  const floor = parseVersion(minimum);
  if (!floor) return `the minimum version ${minimum} is not a valid version`;
  if (!server) return `the serving version ${serving} is not a valid version`;
  if (server.core[0] !== floor.core[0]) {
    return `Codex ${serving} is a different major version from the generated bindings (${minimum}); regenerate and review them`;
  }
  // Compare minor, then patch; the first difference decides.
  for (const index of [1, 2] as const) {
    if (server.core[index] > floor.core[index]) return undefined;
    if (server.core[index] < floor.core[index]) return `Codex ${serving} is older than the generated bindings require (${minimum} or newer)`;
  }
  if (server.prerelease && !floor.prerelease) return `Codex ${serving} is a prerelease of the minimum version ${minimum}`;
  return undefined;
}

/**
 * Version housekeeping: the plugin release version, the donsetch
 * release a fresh install pins for its binary, and a strict semver
 * parser used for update decisions. No deps.
 */

/** Bump together with package.json on plugin releases. */
export const PLUGIN_VERSION = '1.1.1'

/**
 * The donsetch release a fresh plugin install downloads. Auto-update
 * then tracks newer releases per the configured channel; this pin is
 * the floor, not a ceiling. Bump on donsetch patch releases when the
 * plugin wants a newer baseline.
 */
export const PINNED_DONSETCH_VERSION = '4.2.9'

export interface Semver {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers (e.g. ["rc", "1"]), normalized lowercase. */
  prerelease: string[]
}

/** All-numeric characters, base-independent digit check. */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/**
 * Strict-ish semver: v-prefix allowed, dot-separated numeric core,
 * optional -prerelease.N suffix. Anything else returns null. This is
 * used to gate release tags before we ever trust or install them, so
 * it is intentionally conservative.
 */
export function parseSemver(input: string): Semver | null {
  let s = (input ?? '').trim()
  if (!s) return null
  if (s.startsWith('v') || s.startsWith('V')) s = s.slice(1)
  if (s.length > 64) return null

  const dash = s.indexOf('-')
  let core = s
  let prerelease: string[] = []
  if (dash !== -1) {
    core = s.slice(0, dash)
    const pre = s.slice(dash + 1)
    if (!pre) return null
    prerelease = pre.split('.').map((p) => p.toLowerCase())
    // Conservative charset: [0-9A-Za-z] per identifier. No dashes,
    // no dots besides separators, nothing that can smuggle control
    // characters into paths we later create from the version.
    if (prerelease.some((p) => p.length === 0 || p.length > 32 || !/^[0-9A-Za-z]+$/.test(p))) return null
  }

  const parts = core.split('.')
  if (parts.length !== 3) return null
  if (parts.some((p) => p.length === 0 || p.length > 9 || ![...p].every(isDigit))) return null

  return {
    major: Number(parts[0]),
    minor: Number(parts[1]),
    patch: Number(parts[2]),
    prerelease,
  }
}

function comparePre(a: string[], b: string[]): number {
  // Release > prerelease.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y) < 0 ? -1 : 1
    if (xn) return -1 // numeric identifiers sort before alphanumeric
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** -1 / 0 / 1. Non-semver inputs compare as "older than everything". */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return comparePre(pa.prerelease, pb.prerelease)
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0
}

/** Highest version in a list, by strict semver; null when none parse. */
export function highestVersion(versions: string[]): string | null {
  let best: string | null = null
  for (const v of versions) {
    if (parseSemver(v) === null) continue
    if (best === null || isNewer(v, best)) best = v
  }
  return best
}
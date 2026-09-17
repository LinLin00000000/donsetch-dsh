/**
 * Version housekeeping: the plugin release version, the donsetch
 * release a fresh install pins for its binary, and a strict semver
 * parser used for update decisions. No deps.
 */
/** Bump together with package.json on plugin releases. */
export declare const PLUGIN_VERSION = "1.1.0";
/**
 * The donsetch release a fresh plugin install downloads. Auto-update
 * then tracks newer releases per the configured channel; this pin is
 * the floor, not a ceiling. Bump on donsetch patch releases when the
 * plugin wants a newer baseline.
 */
export declare const PINNED_DONSETCH_VERSION = "4.1.1";
export interface Semver {
    major: number;
    minor: number;
    patch: number;
    /** Prerelease identifiers (e.g. ["rc", "1"]), normalized lowercase. */
    prerelease: string[];
}
/**
 * Strict-ish semver: v-prefix allowed, dot-separated numeric core,
 * optional -prerelease.N suffix. Anything else returns null. This is
 * used to gate release tags before we ever trust or install them, so
 * it is intentionally conservative.
 */
export declare function parseSemver(input: string): Semver | null;
/** -1 / 0 / 1. Non-semver inputs compare as "older than everything". */
export declare function compareSemver(a: string, b: string): number;
/** True when `candidate` is strictly newer than `current`. */
export declare function isNewer(candidate: string, current: string): boolean;
/** Highest version in a list, by strict semver; null when none parse. */
export declare function highestVersion(versions: string[]): string | null;

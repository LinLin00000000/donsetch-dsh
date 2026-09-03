/**
 * Binary provisioning: resolve an existing donsetch binary, download
 * and SHA256-verify one from GitHub Releases when missing, extract it
 * (system tar, present on every supported OS), and check for newer
 * releases on a throttled schedule. No deps.
 */
import { type Semver } from './version.js';
interface PlatformInfo {
    key: string;
    asset: string;
    supported: boolean;
}
export declare const PLATFORM: PlatformInfo;
export declare function cacheDir(): string;
export declare function binDir(version: string): string;
export declare function binaryAt(version: string): string;
/** Latest installed version under the cache, or null. */
export declare function installedVersions(): Semver[];
export interface ResolvedBinary {
    path: string;
    version: string;
    source: 'release' | 'path';
}
export interface DownloadOptions {
    /** Timeouts in ms. */
    timeoutMs?: number;
    onProgress?(state: string): void;
}
/**
 * Resolve the binary to run. Order:
 *  1. DONSETCH_BIN env override (absolute or on PATH).
 *  2. The newest verified release binary already in the cache.
 *  3. A fresh download of `pinned` from GitHub Releases, verified.
 *  4. A `donsetch` on PATH, when allowPathFallback (degraded).
 */
export declare function resolveBinary(pinned: string, allowPathFallback: boolean, options?: DownloadOptions): Promise<ResolvedBinary>;
/**
 * Download the pinned release asset, verify its .sha256 sidecar,
 * extract to its own versioned dir, and atomically swap it in.
 */
export declare function downloadBinary(version: string, options?: DownloadOptions): Promise<string>;
export interface HttpResult {
    ok: boolean;
    status: number;
    /** Drain and discard the body, releasing the socket. */
    drain(): Promise<void>;
    /** Full body text, capped; rejects when the cap is exceeded. */
    text(maxBytes: number): Promise<string>;
    /** Async-iterable body chunks. */
    [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}
export interface UpdateInfo {
    current: string;
    latest: string;
    newer: boolean;
}
/**
 * Update check, throttled to `intervalHours`. Never throws: update
 * failures must not block tool service. Returns null when nothing
 * new on the channel.
 */
export declare function checkForUpdate(currentVersion: string, channel: 'stable' | 'latest', intervalHours: number): Promise<UpdateInfo | null>;
export {};

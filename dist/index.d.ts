/**
 * @dsh-external/donsetch : first-class DonSeTch web access for
 * DeepSeek Harness.
 *
 * The plugin spawns ONE supervised `donsetch mcp` daemon, registers
 * every tool the daemon lists (tool parity with the standard
 * donsetch MCP server is guaranteed by construction), and proxies
 * calls with the same JSON-RPC discipline as the pi extension: real
 * cancellation, per-call timeouts, clean restart on daemon loss.
 *
 * Native-feel pieces:
 * - tools are registered in-process on ctx.tools with clean names
 *   (donsetch_web_fetch, not mcp__donsetch__web_fetch) and flow
 *   through dsh's full permission/timeout/cancellation pipeline;
 * - each tool carries call/result cards for the Web workbench;
 * - the donsetch config file (the one `donsetch keys add` writes) is
 *   watched, so CLI changes from any terminal reach the live daemon;
 * - a donsetch_status tool reports version, daemon state, and the
 *   doctor output so the agent can self-diagnose;
 * - the binary auto-updates from GitHub Releases on the configured
 *   channel, SHA256-verified, swapped only between in-flight calls.
 *
 * Zero runtime imports from the host train: the plugin talks to the
 * harness exclusively through the ctx handed to apply().
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "donsetch";
export declare const inject: readonly ["tools"];
export type UpdateChannel = 'stable' | 'latest';
export interface DonsetchConfig {
    /** Model-facing tool prefix; default donsetch. */
    toolPrefix?: string;
    /** Release channel for auto-updates. */
    channel?: UpdateChannel;
    /** Auto-download+swap newer donsetch releases. Default true. */
    autoUpdate?: boolean;
    /** Minimum gap between update checks, hours. Default 24. */
    updateIntervalHours?: number;
    /** Per-call MCP timeout, ms. Default 180000. */
    callTimeoutMs?: number;
    /** Initialize + tools/list timeout, ms. Default 20000. */
    bootTimeoutMs?: number;
    /** Fall back to a donsetch already on PATH when download fails. */
    fallbackToPath?: boolean;
    /** donsetch release pinned for fresh installs (floor, not ceiling). */
    pinnedVersion?: string;
}
/**
 * Per-call timeout for one tools/call. The configured callTimeoutMs is a
 * single bound for every tool, but the binary's own budgets are larger
 * than it: web_crawl accepts deadline_s up to 600 and web_fetch
 * deadline_ms up to 600000, so a legal call was being killed by the
 * client while the server was still inside its documented deadline (the
 * crawl default of 120s already sat inside the 180s default, racing
 * it). Derive the timeout from the call's own budget plus slack, capped
 * at the largest budget the schemas allow so a hostile argument cannot
 * hold a slot forever.
 */
export declare function callTimeoutFor(name: string, args: unknown, baseMs: number): number;
/** Resolve the config file the real donsetch CLI reads, per OS. */
export declare function donsetchConfigPath(): string;
/**
 * The file the real CLI writes provider keys into (`donsetch keys
 * add` -> cache_dir/byok-keys.json). This is the state Dondai
 * expects to carry over: watch it, and surface its path in status.
 */
export declare function donsetchKeysPath(): string;
export declare function apply(ctx: Context, rawConfig?: DonsetchConfig): {
    dispose(): Promise<void>;
};

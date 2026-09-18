/**
 * MCP JSON-RPC 2.0 client over stdio, speaking to a supervised
 * `donsetch mcp` child process. Ported from the battle-tested
 * donsetch pi-extension with the same discipline: newline-delimited
 * frames, per-request timeouts, real cancellation (the server gets
 * notifications/cancelled and the in-flight work actually stops),
 * EPIPE-safe streams, and stderr isolation.
 */
export interface McpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
export interface McpResult {
    content?: Array<{
        type?: string;
        text?: string;
        [key: string]: unknown;
    } & Record<string, unknown>>;
    isError?: boolean;
    [key: string]: unknown;
}
export interface McpOptions {
    /** Command argv for the donsetch binary, e.g. [bin, 'mcp']. */
    cmd: string[];
    callTimeoutMs: number;
    bootTimeoutMs: number;
    cwd?: string;
    /** Test seam: extra env vars. */
    env?: NodeJS.ProcessEnv;
}
/**
 * The MCP client owns ONE child process at a time. start() spawns and
 * initializes; after an exit the client resets to the stopped state
 * and every in-flight request is rejected with an exit error. Callers
 * restarted via start() later get a fresh child.
 */
export declare class McpClient {
    readonly tools: McpTool[];
    serverVersion: string | null;
    lastError: string | null;
    private readonly opts;
    private proc;
    private nextId;
    private pending;
    private buffer;
    private stderrTail;
    private stdinError;
    private stopped;
    constructor(options: McpOptions);
    get running(): boolean;
    get healthy(): boolean;
    /**
     * Values are stringified here so configuration can only hand us
     * JSON-safe payloads; avoids JSON.stringify throwing mid-request.
     */
    private write;
    private makeRequest;
    /** Spawn a fresh child, handshake, and pull tools/list. */
    start(): Promise<void>;
    private initialize;
    private listTools;
    /**
     * Call a registered tool. When the signal aborts we tell the real
     * server to stop the in-flight work, not just abandon it.
     */
    callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<McpResult>;
    /** Stderr ring buffer: last 8 KiB of diagnostics, for status output. */
    stderrTailText(): string;
    /** Graceful shutdown: end stdin, TERM, then KILL after grace. */
    dispose(graceMs?: number): Promise<void>;
    /** Instant, brutal teardown for config-swap respawns. */
    kill(): void;
}

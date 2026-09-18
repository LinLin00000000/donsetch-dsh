/**
 * MCP JSON-RPC 2.0 client over stdio, speaking to a supervised
 * `donsetch mcp` child process. Ported from the battle-tested
 * donsetch pi-extension with the same discipline: newline-delimited
 * frames, per-request timeouts, real cancellation (the server gets
 * notifications/cancelled and the in-flight work actually stops),
 * EPIPE-safe streams, and stderr isolation.
 */
import { spawn } from 'node:child_process';
import { PLUGIN_VERSION } from './version.js';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'donsetch';
/** Text lines on stderr matching these survive into the error log. */
const FATAL_RE = /fatal|panic|crash|SIGSEGV|abort|OOM|out of memory/i;
/**
 * The MCP client owns ONE child process at a time. start() spawns and
 * initializes; after an exit the client resets to the stopped state
 * and every in-flight request is rejected with an exit error. Callers
 * restarted via start() later get a fresh child.
 */
export class McpClient {
    tools = [];
    serverVersion = null;
    lastError = null;
    opts;
    proc = null;
    nextId = 1;
    pending = new Map();
    buffer = '';
    stderrTail = '';
    stdinError = null;
    stopped;
    constructor(options) {
        this.opts = options;
        this.stopped = false;
    }
    get running() {
        return this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
    }
    get healthy() {
        return this.running && this.proc?.stdin !== null && this.proc?.stdin?.writable === true;
    }
    /**
     * Values are stringified here so configuration can only hand us
     * JSON-safe payloads; avoids JSON.stringify throwing mid-request.
     */
    write(msg) {
        if (!this.proc?.stdin?.writable) {
            throw new Error('donsetch MCP server is not running');
        }
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }
    makeRequest(method, params, timeoutMs, signal) {
        return new Promise((resolve, reject) => {
            if (!this.healthy) {
                reject(new Error('donsetch MCP server is not running'));
                return;
            }
            const id = this.nextId++;
            let settled = false;
            const finish = (fn, v) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                fn(v);
            };
            const entry = {
                resolve: (v) => {
                    clearTimeout(entry.timer);
                    finish(resolve, v);
                },
                reject: (e) => {
                    clearTimeout(entry.timer);
                    finish(reject, e);
                },
                timer: setTimeout(() => {
                    if (this.pending.delete(id)) {
                        finish(reject, new Error(`donsetch MCP request timed out after ${timeoutMs}ms: ${method}`));
                    }
                }, timeoutMs),
            };
            const onAbort = () => {
                if (this.pending.delete(id)) {
                    clearTimeout(entry.timer);
                    try {
                        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { id, reason: 'client aborted' } });
                    }
                    catch {
                        // Stream error handler covers the rest.
                    }
                    finish(reject, new Error('donsetch call cancelled'));
                }
            };
            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this.pending.set(id, entry);
            try {
                this.write({ jsonrpc: '2.0', id, method, params });
            }
            catch (err) {
                this.pending.delete(id);
                clearTimeout(entry.timer);
                finish(reject, err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    /** Spawn a fresh child, handshake, and pull tools/list. */
    start() {
        if (this.running)
            return Promise.resolve();
        if (this.proc !== null && !this.stopped) {
            return Promise.reject(new Error('donsetch MCP server is still shutting down'));
        }
        this.stopped = false;
        this.tools.length = 0;
        this.serverVersion = null;
        this.lastError = null;
        this.buffer = '';
        this.stderrTail = '';
        this.stdinError = null;
        return new Promise((resolve, reject) => {
            let proc;
            try {
                // The daemon must never inherit a node test-runner context:
                // spawned inside `node --test` those vars make node children
                // behave as test processes and exit immediately.
                const env = { ...process.env, ...this.opts.env };
                const underTestRunner = env.NODE_TEST_CONTEXT !== undefined || env.NODE_V8_COVERAGE !== undefined;
                delete env.NODE_TEST_CONTEXT;
                delete env.NODE_V8_COVERAGE;
                if (underTestRunner)
                    delete env.NODE_OPTIONS;
                // Windows can only CreateProcess a real executable. A .cmd/.bat
                // test seam (or a user-supplied wrapper) must route through
                // cmd.exe; the shipped donsetch.exe never does.
                const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.opts.cmd[0] ?? '');
                proc = spawn(this.opts.cmd[0], this.opts.cmd.slice(1), {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                    cwd: this.opts.cwd,
                    windowsHide: true,
                    ...(useShell ? { shell: true } : {}),
                });
            }
            catch (err) {
                reject(new Error(`failed to spawn donsetch: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
            this.proc = proc;
            proc.stdout?.on('data', (chunk) => {
                this.buffer += chunk.toString();
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    let msg;
                    try {
                        msg = JSON.parse(trimmed);
                    }
                    catch {
                        // Non-JSON on stdout is not protocol; ignore.
                        continue;
                    }
                    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
                        const entry = this.pending.get(msg.id);
                        this.pending.delete(msg.id);
                        clearTimeout(entry.timer);
                        if (msg.error) {
                            const message = msg.error && typeof msg.error === 'object' && typeof msg.error.message === 'string'
                                ? msg.error.message
                                : 'MCP error';
                            entry.reject(new Error(message));
                        }
                        else {
                            entry.resolve(msg.result);
                        }
                    }
                }
            });
            proc.stderr?.on('data', (chunk) => {
                this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
            });
            const failAll = (err) => {
                this.proc = null;
                this.lastError = err.message;
                for (const [, e] of [...this.pending]) {
                    clearTimeout(e.timer);
                    e.reject(err);
                }
                this.pending.clear();
            };
            proc.on('error', (err) => {
                if (err.message.includes('ENOENT')) {
                    failAll(new Error(`donsetch binary not found at ${this.opts.cmd[0]}: ${err.message}`));
                }
                else {
                    failAll(err);
                }
            });
            proc.on('exit', (code, signal) => {
                const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
                const diagnostics = this.stderrTail.trim().slice(-400);
                failAll(new Error(`donsetch MCP server exited (${detail})${diagnostics ? ` stderr: \"${diagnostics}\"` : ''}`));
            });
            const onStreamError = (err) => {
                this.stdinError = err;
                failAll(new Error(`donsetch MCP stream error: ${err.code ?? err.message}`));
                if (this.proc) {
                    try {
                        this.proc.kill('SIGKILL');
                    }
                    catch {
                        // Already gone.
                    }
                }
            };
            proc.stdin?.on('error', onStreamError);
            proc.stdout?.on('error', onStreamError);
            proc.stderr?.on('error', onStreamError);
            void this.initialize()
                .then(() => this.listTools())
                .then((tools) => {
                this.tools.push(...tools);
                resolve();
            })
                .catch((err) => {
                failAll(err instanceof Error ? err : new Error(String(err)));
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }
    initialize() {
        return this.makeRequest('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'dsh-donsetch', version: PLUGIN_VERSION },
        }, this.opts.bootTimeoutMs).then((result) => {
            const info = result && typeof result === 'object' ? result.serverInfo : undefined;
            const v = info && typeof info.version === 'string' ? info.version : null;
            if (v !== null)
                this.serverVersion = v;
            try {
                this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
            }
            catch {
                // Exit handler settles the pending path.
            }
        });
    }
    listTools() {
        return this.makeRequest('tools/list', {}, this.opts.bootTimeoutMs).then((result) => {
            const raw = result && typeof result === 'object' ? result.tools : undefined;
            if (!Array.isArray(raw))
                return [];
            const out = [];
            for (const entry of raw) {
                if (entry === null || typeof entry !== 'object')
                    continue;
                const t = entry;
                if (typeof t.name !== 'string' || t.name.length === 0)
                    continue;
                const tool = { name: t.name };
                if (typeof t.description === 'string')
                    tool.description = t.description;
                if (t.inputSchema !== null && typeof t.inputSchema === 'object') {
                    tool.inputSchema = t.inputSchema;
                }
                out.push(tool);
            }
            return out;
        });
    }
    /**
     * Call a registered tool. When the signal aborts we tell the real
     * server to stop the in-flight work, not just abandon it.
     */
    callTool(name, args, signal, timeoutMs) {
        return this.makeRequest('tools/call', { name, arguments: args ?? {} }, 
        // A caller that knows the call's own budget passes it: the
        // configured value is one bound for every tool, and a crawl's
        // legal deadline is larger than it.
        timeoutMs ?? this.opts.callTimeoutMs, signal);
    }
    /** Stderr ring buffer: last 8 KiB of diagnostics, for status output. */
    stderrTailText() {
        return this.stderrTail;
    }
    /** Graceful shutdown: end stdin, TERM, then KILL after grace. */
    async dispose(graceMs = 2000) {
        this.stopped = true;
        const proc = this.proc;
        if (!proc)
            return;
        this.proc = null;
        try {
            proc.stdin?.end();
        }
        catch {
            // Nothing to close.
        }
        try {
            proc.kill('SIGTERM');
        }
        catch {
            // Already gone.
        }
        await new Promise((resolveTimer) => setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch {
                // Already gone.
            }
            resolveTimer(undefined);
        }, graceMs));
        for (const [, e] of [...this.pending]) {
            clearTimeout(e.timer);
            e.reject(new Error('donsetch MCP server shutting down'));
        }
        this.pending.clear();
    }
    /** Instant, brutal teardown for config-swap respawns. */
    kill() {
        const proc = this.proc;
        this.proc = null;
        this.stopped = false;
        if (proc) {
            try {
                proc.kill('SIGKILL');
            }
            catch {
                // Already gone.
            }
        }
        for (const [, e] of [...this.pending]) {
            clearTimeout(e.timer);
            e.reject(new Error('donsetch MCP server restarted'));
        }
        this.pending.clear();
    }
}

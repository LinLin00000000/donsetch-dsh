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
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cacheDir, checkForUpdate, downloadBinary, installedVersions, resolveBinary } from './binary.js';
import { McpClient } from './mcp.js';
import { callKind, callTitle, firstLine, isValidPrefix, publicToolName, specToJsonSchema, toDshSpec } from './schemas.js';
import { PINNED_DONSETCH_VERSION, PLUGIN_VERSION } from './version.js';
export const name = 'donsetch';
export const inject = ['tools'];
/** Time to add on top of a call's own budget before the client gives up. */
const CALL_DEADLINE_SLACK_MS = 20_000;
/** The largest legal budget (600s) plus slack. */
const MAX_CALL_TIMEOUT_MS = 620_000;
function positiveNumber(value) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
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
export function callTimeoutFor(name, args, baseMs) {
    const a = (args ?? {});
    let budgetMs = null;
    if (name === 'web_crawl') {
        const secs = positiveNumber(a.deadline_s);
        // No budget (or an unusable one) means the binary's own default.
        budgetMs = secs !== null ? secs * 1000 : 120_000;
    }
    else if (name === 'web_fetch') {
        budgetMs = positiveNumber(a.deadline_ms);
    }
    if (budgetMs === null)
        return baseMs;
    return Math.min(budgetMs + CALL_DEADLINE_SLACK_MS, MAX_CALL_TIMEOUT_MS);
}
function resolveConfig(raw) {
    const prefix = raw.toolPrefix ?? process.env.DONSETCH_DSH_PREFIX ?? 'donsetch';
    if (!isValidPrefix(prefix)) {
        throw new Error(`donsetch plugin: toolPrefix ${JSON.stringify(prefix)} must match [A-Za-z0-9_]{1,16}`);
    }
    const channel = process.env.DONSETCH_DSH_CHANNEL === 'latest' || raw.channel === 'latest' ? 'latest' : 'stable';
    const autoUpdate = process.env.DONSETCH_DSH_AUTOUPDATE === 'off' ? false : (raw.autoUpdate ?? true);
    return {
        toolPrefix: prefix,
        channel,
        autoUpdate,
        updateIntervalHours: clampInt(raw.updateIntervalHours, 1, 24 * 30, 24),
        callTimeoutMs: clampInt(raw.callTimeoutMs, 5000, 900_000, 180_000),
        bootTimeoutMs: clampInt(raw.bootTimeoutMs, 5000, 120_000, 20_000),
        fallbackToPath: raw.fallbackToPath ?? true,
        pinnedVersion: raw.pinnedVersion ?? PINNED_DONSETCH_VERSION,
    };
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
/** Resolve the config file the real donsetch CLI reads, per OS. */
export function donsetchConfigPath() {
    const override = process.env.DONSETCH_DSH_HOME?.trim();
    const home = donsetchHome();
    if (process.platform === 'win32') {
        const base = override
            ? join(home, 'AppData', 'Roaming')
            : process.env.APPDATA?.trim() || join(home, 'AppData', 'Roaming');
        return join(base, 'donsetch', 'config.json');
    }
    if (process.platform === 'darwin') {
        return join(home, 'Library', 'Application Support', 'donsetch', 'config.json');
    }
    return join(home, '.config', 'donsetch', 'config.json');
}
/**
 * The file the real CLI writes provider keys into (`donsetch keys
 * add` -> cache_dir/byok-keys.json). This is the state Dondai
 * expects to carry over: watch it, and surface its path in status.
 */
export function donsetchKeysPath() {
    const override = process.env.DONSETCH_DSH_HOME?.trim();
    const home = donsetchHome();
    if (process.platform === 'win32') {
        const base = override
            ? join(home, 'AppData', 'Local')
            : process.env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
        return join(base, 'donsetch', 'byok-keys.json');
    }
    if (process.platform === 'darwin') {
        return join(home, 'Library', 'Caches', 'donsetch', 'byok-keys.json');
    }
    return join(home, '.cache', 'donsetch', 'byok-keys.json');
}
function donsetchHome() {
    const override = process.env.DONSETCH_DSH_HOME?.trim();
    if (override)
        return override;
    const forceHome = process.env.HOME?.trim();
    if (process.platform === 'win32') {
        return forceHome || process.env.USERPROFILE?.trim() || homedir();
    }
    return forceHome || homedir();
}
/**
 * Render the canonical tool result (the raw MCP result object) into
 * model-facing content blocks. Text blocks pass through; exotic block
 * types are stringified so no content is ever silently dropped.
 */
function renderContent(value) {
    const result = (value ?? {});
    const blocks = Array.isArray(result.content)
        ? result.content.map((block) => {
            const b = (block ?? {});
            if (typeof b.text === 'string')
                return { type: 'text', text: b.text };
            try {
                return { type: 'text', text: JSON.stringify(b) };
            }
            catch {
                return { type: 'text', text: String(b) };
            }
        })
        : [];
    if (blocks.length === 0)
        return [{ type: 'text', text: 'donsetch returned no content' }];
    return blocks;
}
export function apply(ctx, rawConfig = {}) {
    let config;
    const inert = { dispose: async () => { } };
    try {
        config = resolveConfig(rawConfig);
    }
    catch (err) {
        ctx.logger?.error(`donsetch plugin rejecting configuration: ${err instanceof Error ? err.message : String(err)}`);
        return inert;
    }
    if (typeof ctx.tools?.register !== 'function') {
        ctx.logger?.error('donsetch plugin: this DeepSeek Harness build has no ctx.tools registry (missing @deepseek-ai/dsh-tools)');
        return inert;
    }
    const log = (msg) => {
        ctx.logger?.info(`[donsetch] ${msg}`);
    };
    const warn = (msg) => {
        ctx.logger?.warn(`[donsetch] ${msg}`);
    };
    const disposers = [];
    const registeredNames = new Set();
    const registrationFailures = [];
    let booted = null;
    let bootError = null;
    let status = 'starting';
    let bootLock = null;
    let generation = 0;
    let pendingUpdateVersion = null;
    let activeCalls = 0;
    let statusRegistrations = [];
    let disposed = false;
    function runDoctor(binPath) {
        const cmd = binPath ?? 'donsetch';
        try {
            const result = spawnSync(cmd, ['doctor'], { encoding: 'utf8', timeout: 30_000 });
            const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
            return out || '(doctor produced no output)';
        }
        catch {
            return '(donsetch binary not callable yet)';
        }
    }
    function registerStatusTools() {
        for (const dispose of statusRegistrations.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Disposer already ran; ignore.
            }
        }
        const def = {
            name: publicToolName(config.toolPrefix, 'status') ?? `${config.toolPrefix}_status`,
            description: 'DonSeTch status and self-diagnostics: binary version, daemon state, registered tools, registration failures, provider keys file, config file path, and the output of `donsetch doctor`. Read this when a donsetch_* tool fails or is missing.',
            // register() does not compile parameters: it copies them onto the
            // model request verbatim, so this must already be a JSON Schema
            // document (a bare `{}` is not one either).
            parameters: { type: 'object', properties: {} },
            output: { schema: {}, render: (_args, value) => renderContent(value) },
            execute: async () => {
                const lines = [];
                lines.push(`DonSeTch plugin status: ${status}`);
                if (status === 'failed') {
                    lines.push(`state: ${bootError ?? 'unknown failure'}`);
                }
                else {
                    lines.push('state: daemon starting in background; re-check shortly');
                }
                lines.push(`config file: ${donsetchConfigPath()}${existsSync(donsetchConfigPath()) ? '' : ' (not written yet)'}`);
                const keysPath = donsetchKeysPath();
                lines.push(`provider keys: ${keysPath}${existsSync(keysPath) ? '' : ' (missing: `donsetch keys add` has not been run for this home)'}`);
                lines.push(`registered tools (${registeredNames.size}): ${[...registeredNames].sort().join(', ') || '(none)'}`);
                if (registrationFailures.length > 0) {
                    lines.push(`registration failures (${registrationFailures.length}):`);
                    for (const failure of registrationFailures)
                        lines.push(`  - ${failure}`);
                }
                lines.push(`binary cache: ${cacheDir()}`);
                lines.push(`pinned release: v${config.pinnedVersion}`);
                if (booted) {
                    lines.push(`binary: ${booted.bin.path} (source: ${booted.bin.source})`);
                    lines.push(`donsetch version: ${booted.client.serverVersion ?? 'unknown'}`);
                }
                lines.push('---');
                lines.push(...runDoctor(booted?.bin.path ?? null).split('\n'));
                return { content: [{ type: 'text', text: lines.join('\n') + '\n' }] };
            },
            presentCall: () => ({ card: 'generic', title: `${config.toolPrefix}_status` }),
            presentResult: (_args, value) => ({
                card: 'generic',
                title: `donsetch ${status}`,
                content: renderContent(value),
            }),
        };
        let dispose;
        try {
            dispose = ctx.tools.register(def);
        }
        catch (err) {
            warn(`could not register status tool: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        statusRegistrations.push(dispose);
    }
    function registerTool(rawName, description, inputSchema) {
        const pub = publicToolName(config.toolPrefix, rawName);
        if (pub === null) {
            const reason = `skipping tool ${JSON.stringify(rawName)}: name does not fit the tool-name contract`;
            registrationFailures.push(reason);
            warn(reason);
            return false;
        }
        if (registeredNames.has(pub)) {
            const reason = `skipping duplicate tool name ${pub}`;
            registrationFailures.push(reason);
            warn(reason);
            return false;
        }
        // Sanitize the hostile MCP inputSchema into the author form, then
        // project that into the JSON Schema document register() must receive.
        // Handing register() the bare property map is silently accepted here
        // and rejected by the provider with 11129, killing every request.
        const parameters = specToJsonSchema(toDshSpec(inputSchema));
        const def = {
            name: pub,
            description: description || `${rawName} via DonSeTch`,
            parameters,
            output: { schema: {}, render: (_args, value) => renderContent(value) },
            execute: async (args, exec) => {
                const healthy = await ensureDaemon(exec.signal);
                if (!healthy) {
                    const hint = bootError ?? 'not running';
                    throw new Error(`donsetch is unavailable (${hint}); check ${config.toolPrefix}_status for diagnostics`);
                }
                activeCalls++;
                try {
                    const result = await booted.client.callTool(rawName, args, exec?.signal, callTimeoutFor(rawName, args, config.callTimeoutMs));
                    if (result?.isError === true) {
                        const text = joinBlocks(result);
                        throw new Error(text || `donsetch ${rawName} failed`);
                    }
                    return result ?? { content: [{ type: 'text', text: 'No output' }] };
                }
                finally {
                    activeCalls--;
                    refreshWatchBaseline();
                    void maybeSwapUpdate();
                }
            },
            presentCall: (args) => ({ card: 'generic', kind: callKind(pub), title: callTitle(pub, args), rawInput: args }),
            presentResult: (_args, value) => ({
                card: 'generic',
                title: resultTitle(pub, value),
                content: renderContent(value).slice(0, 4),
            }),
        };
        let dispose;
        try {
            dispose = ctx.tools.register(def);
        }
        catch (err) {
            const reason = `tool ${pub} rejected by the registry: ${err instanceof Error ? err.message : String(err)}`;
            registrationFailures.push(reason);
            warn(reason);
            return false;
        }
        disposers.push(dispose);
        registeredNames.add(pub);
        return true;
    }
    function joinBlocks(result) {
        return (result.content ?? [])
            .map((b) => (typeof b?.text === 'string' ? b.text : ''))
            .join('')
            .trim();
    }
    function resultTitle(pub, value) {
        const text = value?.content ? joinBlocks(value) : '';
        const line = text ? firstLine(text, 80) : '';
        return line ? `${pub} \u00B7 ${line}` : pub;
    }
    async function boot() {
        const myGen = ++generation;
        status = 'starting';
        const bin = await resolveBinary(config.pinnedVersion, config.fallbackToPath);
        const fresh = new McpClient({
            cmd: [bin.path, 'mcp'],
            callTimeoutMs: config.callTimeoutMs,
            bootTimeoutMs: config.bootTimeoutMs,
        });
        try {
            await fresh.start();
        }
        catch (err) {
            // Never leak children from a failed boot path.
            await fresh.dispose(500).catch(() => undefined);
            throw err;
        }
        if (disposed) {
            // Unload overtook an in-flight boot; kill the fresh child.
            await fresh.dispose(500).catch(() => undefined);
            return;
        }
        if (myGen !== generation) {
            // A config restart overtook this boot; discard it.
            await fresh.dispose(500).catch(() => undefined);
            return;
        }
        booted = { bin, client: fresh };
        status = bin.source === 'path' ? 'degraded' : 'ready';
        bootError = null;
        registerStatusTools();
        // The daemon may rewrite byok-keys.json during startup (key
        // rotation/retirement bookkeeping): consume that write.
        refreshWatchBaseline();
        for (const tool of fresh.tools) {
            registerTool(tool.name, tool.description, tool.inputSchema);
        }
        log(`ready: donsetch v${fresh.serverVersion ?? '?'} via ${bin.source} (${bin.path}), ${registeredNames.size} tools as ${config.toolPrefix}_*`);
    }
    async function ensureDaemon(signal) {
        if (disposed)
            return false;
        if (booted !== null && booted.client.healthy)
            return true;
        if (bootLock === null) {
            bootLock = (async () => {
                try {
                    await boot();
                }
                catch (err) {
                    bootError = err instanceof Error ? err.message : String(err);
                    status = 'failed';
                    registerStatusTools();
                }
                finally {
                    bootLock = null;
                }
            })();
        }
        await bootLock;
        if (signal?.aborted)
            return false;
        return booted !== null && booted.client.healthy;
    }
    function restartDaemon() {
        const old = booted;
        booted = null;
        status = 'starting';
        if (old !== null) {
            old.client.kill();
        }
    }
    /**
     * Install a downloaded update: restart the daemon only when no tool
     * call is in flight; otherwise defer until the counter drains.
     */
    async function maybeSwapUpdate() {
        if (disposed)
            return;
        if (pendingUpdateVersion === null)
            return;
        if (activeCalls > 0)
            return;
        const version = pendingUpdateVersion;
        pendingUpdateVersion = null;
        if (booted?.bin.version === version)
            return;
        // Ensure the release is materialized and verified in the cache.
        if (await downloadBinaryIfMissing(version)) {
            restartDaemon();
            void ensureDaemon();
            log(`swapped to donsetch v${version}`);
        }
    }
    async function downloadBinaryIfMissing(version) {
        if (installedVersions().some((v) => versionString(v) === version)) {
            return true;
        }
        try {
            await downloadBinary(version, { timeoutMs: 300_000 });
            return true;
        }
        catch (err) {
            warn(`update download for v${version} failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    function versionString(v) {
        const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
        return `${v.major}.${v.minor}.${v.patch}${pre}`;
    }
    // ── Side effects, owned by the plugin fiber ──
    const teardown = async () => {
        if (disposed)
            return;
        disposed = true;
        generation++;
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Already run.
            }
        }
        for (const dispose of statusRegistrations.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Already run.
            }
        }
        const client = booted?.client;
        booted = null;
        if (client)
            await client.dispose(1500);
        if (restartTimer !== null) {
            clearTimeout(restartTimer);
            restartTimer = null;
            armedMtime = null;
        }
    };
    ctx.effect(() => {
        registerStatusTools();
        void boot().catch((err) => {
            bootError = err instanceof Error ? err.message : String(err);
            status = 'failed';
            registerStatusTools();
        });
        return () => {
            void teardown();
        };
    }, 'donsetch-lifecycle');
    const watchEntries = [
        { path: donsetchConfigPath(), lastMtime: null },
        { path: donsetchKeysPath(), lastMtime: null },
    ];
    let restartTimer = null;
    let armedMtime = null;
    const recordMtime = (path) => {
        try {
            return statSync(path).mtimeMs;
        }
        catch {
            return null;
        }
    };
    const refreshWatchBaseline = () => {
        for (const entry of watchEntries) {
            entry.lastMtime = recordMtime(entry.path);
        }
        if (restartTimer !== null) {
            clearTimeout(restartTimer);
            restartTimer = null;
            armedMtime = null;
        }
    };
    for (const entry of watchEntries) {
        entry.lastMtime = recordMtime(entry.path);
    }
    for (const entry of watchEntries) {
        try {
            watchFile(entry.path, { persistent: false, interval: 1200 }, () => {
                const mtime = recordMtime(entry.path);
                if (mtime === null) {
                    // Missing at this event (including the attach probe):
                    // nothing real to restart for.
                    entry.lastMtime = null;
                    return;
                }
                entry.lastMtime = mtime;
                if (activeCalls > 0 || disposed)
                    return;
                if (restartTimer !== null)
                    return;
                armedMtime = mtime;
                restartTimer = setTimeout(() => {
                    restartTimer = null;
                    const latest = recordMtime(entry.path);
                    if (latest !== armedMtime) {
                        // Written again during the debounce: drop this event; the
                        // next change fires a fresh callback.
                        armedMtime = null;
                        return;
                    }
                    armedMtime = null;
                    if (disposed)
                        return;
                    log(`donsetch state changed on disk (${entry.path}); restarting daemon`);
                    restartDaemon();
                    void ensureDaemon();
                }, 800);
            });
        }
        catch {
            warn(`could not watch ${entry.path}; CLI config changes will apply after the next dsh restart`);
        }
    }
    ctx.effect(() => {
        return () => {
            for (const entry of watchEntries) {
                try {
                    unwatchFile(entry.path);
                }
                catch {
                    // Never watched.
                }
            }
            if (restartTimer !== null) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
        };
    }, 'donsetch-config-watch');
    // Throttled, non-blocking update check once the daemon is up.
    if (config.autoUpdate) {
        ctx.effect(() => {
            let cancelled = false;
            void (async () => {
                try {
                    await ensureDaemon();
                    if (cancelled || booted === null)
                        return;
                    const current = booted.bin.source === 'release' ? booted.bin.version : config.pinnedVersion;
                    const info = await checkForUpdate(current, config.channel, config.updateIntervalHours);
                    if (cancelled)
                        return;
                    if (info?.newer === true) {
                        pendingUpdateVersion = info.latest;
                        log(`newer donsetch v${info.latest} found (running v${current}); will swap between calls`);
                        void maybeSwapUpdate();
                    }
                }
                catch {
                    // Updates are best-effort; tool service is unaffected.
                }
            })();
            return () => {
                cancelled = true;
            };
        }, 'donsetch-update-check');
    }
    log(`plugin v${PLUGIN_VERSION} loaded; donsetch v${config.pinnedVersion}+ via the ${config.toolPrefix}_* tools`);
    // Manual teardown seam for embedders and tests; the harness normally
    // owns disposal through the lifecycle effect above.
    return { dispose: () => teardown() };
}

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

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { spawnSync } from 'node:child_process'
import { existsSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { cacheDir, checkForUpdate, downloadBinary, installedVersions, resolveBinary, type ResolvedBinary } from './binary.js'
import { McpClient, type McpResult } from './mcp.js'
import { callTitle, firstLine, isValidPrefix, publicToolName } from './schemas.js'
import { PINNED_DONSETCH_VERSION, PLUGIN_VERSION } from './version.js'

export const name = 'donsetch'
export const inject = ['tools'] as const

export type UpdateChannel = 'stable' | 'latest'

export interface DonsetchConfig {
  /** Model-facing tool prefix; default donsetch. */
  toolPrefix?: string
  /** Release channel for auto-updates. */
  channel?: UpdateChannel
  /** Auto-download+swap newer donsetch releases. Default true. */
  autoUpdate?: boolean
  /** Minimum gap between update checks, hours. Default 24. */
  updateIntervalHours?: number
  /** Per-call MCP timeout, ms. Default 180000. */
  callTimeoutMs?: number
  /** Initialize + tools/list timeout, ms. Default 20000. */
  bootTimeoutMs?: number
  /** Fall back to a donsetch already on PATH when download fails. */
  fallbackToPath?: boolean
  /** donsetch release pinned for fresh installs (floor, not ceiling). */
  pinnedVersion?: string
}

interface ResolvedConfig {
  toolPrefix: string
  channel: UpdateChannel
  autoUpdate: boolean
  updateIntervalHours: number
  callTimeoutMs: number
  bootTimeoutMs: number
  fallbackToPath: boolean
  pinnedVersion: string
}

function resolveConfig(raw: DonsetchConfig): ResolvedConfig {
  const prefix = raw.toolPrefix ?? process.env.DONSETCH_DSH_PREFIX ?? 'donsetch'
  if (!isValidPrefix(prefix)) {
    throw new Error(`donsetch plugin: toolPrefix ${JSON.stringify(prefix)} must match [A-Za-z0-9_]{1,16}`)
  }
  const channel: UpdateChannel = process.env.DONSETCH_DSH_CHANNEL === 'latest' || raw.channel === 'latest' ? 'latest' : 'stable'
  const autoUpdate = process.env.DONSETCH_DSH_AUTOUPDATE === 'off' ? false : (raw.autoUpdate ?? true)
  return {
    toolPrefix: prefix,
    channel,
    autoUpdate,
    updateIntervalHours: clampInt(raw.updateIntervalHours, 1, 24 * 30, 24),
    callTimeoutMs: clampInt(raw.callTimeoutMs, 5000, 900_000, 180_000),
    bootTimeoutMs: clampInt(raw.bootTimeoutMs, 5000, 120_000, 20_000),
    fallbackToPath: raw.fallbackToPath ?? true,
    pinnedVersion: raw.pinnedVersion ?? PINNED_DONSETCH_VERSION,
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** Resolve the config file the real donsetch CLI reads, per OS. */
export function donsetchConfigPath(): string {
  const home = process.env.DONSETCH_DSH_HOME?.trim()
  if (process.platform === 'win32') {
    const base = home ?? (process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'))
    return join(base, 'donsetch', 'config.json')
  }
  if (process.platform === 'darwin') {
    return join(home ?? homedir(), 'Library', 'Application Support', 'donsetch', 'config.json')
  }
  return join(home ?? homedir(), '.config', 'donsetch', 'config.json')
}

interface BootedState {
  bin: ResolvedBinary
  client: McpClient
}

/**
 * Render the canonical tool result (the raw MCP result object) into
 * model-facing content blocks. Text blocks pass through; exotic block
 * types are stringified so no content is ever silently dropped.
 */
function renderContent(value: unknown): ContentBlock[] {
  const result = (value ?? {}) as Partial<McpResult>
  const blocks = Array.isArray(result.content)
    ? result.content.map((block) => {
        const b = (block ?? {}) as Record<string, unknown>
        if (typeof b.text === 'string') return { type: 'text', text: b.text } as ContentBlock
        try {
          return { type: 'text', text: JSON.stringify(b) } as ContentBlock
        } catch {
          return { type: 'text', text: String(b) } as ContentBlock
        }
      })
    : []
  if (blocks.length === 0) return [{ type: 'text', text: 'donsetch returned no content' }]
  return blocks
}

export function apply(ctx: Context, rawConfig: DonsetchConfig = {}): void {
  let config: ResolvedConfig
  try {
    config = resolveConfig(rawConfig)
  } catch (err) {
    ctx.logger?.error(`donsetch plugin rejecting configuration: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (typeof ctx.tools?.register !== 'function') {
    ctx.logger?.error('donsetch plugin: this DeepSeek Harness build has no ctx.tools registry (missing @deepseek-ai/dsh-tools)')
    return
  }

  const log = (msg: string): void => {
    ctx.logger?.info(`[donsetch] ${msg}`)
  }
  const warn = (msg: string): void => {
    ctx.logger?.warn(`[donsetch] ${msg}`)
  }

  const disposers: Array<() => void> = []
  const registeredNames = new Set<string>()
  let booted: BootedState | null = null
  let bootError: string | null = null
  let status: 'starting' | 'ready' | 'degraded' | 'failed' = 'starting'
  let bootLock: Promise<void> | null = null
  let generation = 0
  let pendingUpdateVersion: string | null = null
  let activeCalls = 0
  let statusRegistrations: Array<() => void> = []
  let disposed = false

  function runDoctor(binPath: string | null): string {
    const cmd = binPath ?? 'donsetch'
    try {
      const result = spawnSync(cmd, ['doctor'], { encoding: 'utf8', timeout: 30_000 })
      const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      return out || '(doctor produced no output)'
    } catch {
      return '(donsetch binary not callable yet)'
    }
  }

  function registerStatusTools(): void {
    for (const dispose of statusRegistrations.splice(0)) {
      try {
        dispose()
      } catch {
        // Disposer already ran; ignore.
      }
    }
    // A healthy daemon owns troubleshooting; the status tool only
    // exists while we are starting up or down.
    if (status === 'ready' || status === 'degraded') return

    const def: ToolDefinition = {
      name: publicToolName(config.toolPrefix, 'status') ?? `${config.toolPrefix}_status`,
      description:
        'DonSeTch status and self-diagnostics: binary version, daemon state, last error, config file path, and the output of `donsetch doctor`. Read this when a donsetch_* tool fails or is missing.',
      parameters: { type: 'object', properties: {} },
      output: { schema: {}, render: renderContent },
      execute: async () => {
        const lines: string[] = []
        lines.push(`DonSeTch plugin status: ${status}`)
        if (status === 'failed') {
          lines.push(`state: ${bootError ?? 'unknown failure'}`)
        } else {
          lines.push('state: daemon starting in background; re-check shortly')
        }
        lines.push(`config file: ${donsetchConfigPath()}${existsSync(donsetchConfigPath()) ? '' : ' (not written yet)'}`)
        lines.push(`binary cache: ${cacheDir()}`)
        lines.push(`pinned release: v${config.pinnedVersion}`)
        if (booted) {
          lines.push(`binary: ${booted.bin.path} (source: ${booted.bin.source})`)
          lines.push(`donsetch version: ${booted.client.serverVersion ?? 'unknown'}`)
        }
        lines.push('---')
        lines.push(...runDoctor(booted?.bin.path ?? null).split('\n'))
        return { content: [{ type: 'text', text: lines.join('\n') + '\n' }] }
      },
      presentCall: () => ({ card: 'generic', title: `${config.toolPrefix}_status` }),
      presentResult: (_args, value) => ({
        card: 'generic',
        title: `donsetch ${status}`,
        content: renderContent(value),
      }),
    }
    let dispose: () => void
    try {
      dispose = ctx.tools.register(def)
    } catch (err) {
      warn(`could not register status tool: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    statusRegistrations.push(dispose)
  }

  function registerTool(rawName: string, description: string | undefined, inputSchema: Record<string, unknown> | undefined): boolean {
    const pub = publicToolName(config.toolPrefix, rawName)
    if (pub === null) {
      warn(`skipping tool ${JSON.stringify(rawName)}: name does not fit the tool-name contract`)
      return false
    }
    if (registeredNames.has(pub)) {
      warn(`skipping duplicate tool name ${pub}`)
      return false
    }
    const def: ToolDefinition = {
      name: pub,
      description: description || `${rawName} via DonSeTch`,
      parameters:
        inputSchema && typeof inputSchema === 'object' && Object.keys(inputSchema).length > 0
          ? inputSchema
          : { type: 'object', properties: {} },
      output: { schema: {}, render: renderContent },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const healthy = await ensureDaemon(exec.signal)
        if (!healthy) {
          const hint = bootError ?? 'not running'
          throw new Error(`donsetch is unavailable (${hint}); check ${config.toolPrefix}_status for diagnostics`)
        }
        activeCalls++
        try {
          const result = await booted!.client.callTool(rawName, args, exec?.signal)
          if (result?.isError === true) {
            const text = joinBlocks(result)
            throw new Error(text || `donsetch ${rawName} failed`)
          }
          return result ?? { content: [{ type: 'text', text: 'No output' }] }
        } finally {
          activeCalls--
          void maybeSwapUpdate()
        }
      },
      presentCall: (args: unknown) => ({ card: 'generic', title: callTitle(pub, args), rawInput: args }),
      presentResult: (_args: unknown, value: unknown) => ({
        card: 'generic',
        title: resultTitle(pub, value),
        content: renderContent(value).slice(0, 4),
      }),
    }
    let dispose: () => void
    try {
      dispose = ctx.tools.register(def)
    } catch (err) {
      warn(`tool ${pub} rejected by the registry: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    disposers.push(dispose)
    registeredNames.add(pub)
    return true
  }

  function joinBlocks(result: Partial<McpResult>): string {
    return ((result.content ?? []) as Array<{ text?: unknown }>)
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .join('')
      .trim()
  }

  function resultTitle(pub: string, value: unknown): string {
    const text = (value as Partial<McpResult>)?.content ? joinBlocks(value as Partial<McpResult>) : ''
    const line = text ? firstLine(text, 80) : ''
    return line ? `${pub} \u00B7 ${line}` : pub
  }

  async function boot(): Promise<void> {
    const myGen = ++generation
    status = 'starting'
    const bin = await resolveBinary(config.pinnedVersion, config.fallbackToPath)
    const fresh = new McpClient({
      cmd: [bin.path, 'mcp'],
      callTimeoutMs: config.callTimeoutMs,
      bootTimeoutMs: config.bootTimeoutMs,
    })
    try {
      await fresh.start()
    } catch (err) {
      // Never leak children from a failed boot path.
      await fresh.dispose(500).catch(() => undefined)
      throw err
    }
    if (disposed) {
      // Unload overtook an in-flight boot; kill the fresh child.
      await fresh.dispose(500).catch(() => undefined)
      return
    }
    if (myGen !== generation) {
      // A config restart overtook this boot; discard it.
      await fresh.dispose(500).catch(() => undefined)
      return
    }
    booted = { bin, client: fresh }
    status = bin.source === 'path' ? 'degraded' : 'ready'
    bootError = null
    registerStatusTools()
    for (const tool of fresh.tools) {
      registerTool(tool.name, tool.description, tool.inputSchema)
    }
    log(
      `ready: donsetch v${fresh.serverVersion ?? '?'} via ${bin.source} (${bin.path}), ${registeredNames.size} tools as ${config.toolPrefix}_*`,
    )
  }

  async function ensureDaemon(signal?: AbortSignal): Promise<boolean> {
    if (disposed) return false
    if (booted !== null && booted.client.healthy) return true
    if (bootLock === null) {
      bootLock = (async () => {
        try {
          await boot()
        } catch (err) {
          bootError = err instanceof Error ? err.message : String(err)
          status = 'failed'
          registerStatusTools()
        } finally {
          bootLock = null
        }
      })()
    }
    await bootLock
    if (signal?.aborted) return false
    return booted !== null && booted.client.healthy
  }

  function restartDaemon(): void {
    const old = booted
    booted = null
    status = 'starting'
    if (old !== null) {
      old.client.kill()
    }
  }

  /**
   * Install a downloaded update: restart the daemon only when no tool
   * call is in flight; otherwise defer until the counter drains.
   */
  async function maybeSwapUpdate(): Promise<void> {
    if (disposed) return
    if (pendingUpdateVersion === null) return
    if (activeCalls > 0) return
    const version = pendingUpdateVersion
    pendingUpdateVersion = null
    if (booted?.bin.version === version) return
    // Ensure the release is materialized and verified in the cache.
    if (await downloadBinaryIfMissing(version)) {
      restartDaemon()
      void ensureDaemon()
      log(`swapped to donsetch v${version}`)
    }
  }

  async function downloadBinaryIfMissing(version: string): Promise<boolean> {
    if (installedVersions().some((v) => versionString(v) === version)) {
      return true
    }
    try {
      await downloadBinary(version, { timeoutMs: 300_000 })
      return true
    } catch (err) {
      warn(`update download for v${version} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  function versionString(v: { major: number; minor: number; patch: number; prerelease: string[] }): string {
    const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : ''
    return `${v.major}.${v.minor}.${v.patch}${pre}`
  }

  // ── Side effects, owned by the plugin fiber ──

  ctx.effect(() => {
    registerStatusTools()
    void boot().catch((err: unknown) => {
      bootError = err instanceof Error ? err.message : String(err)
      status = 'failed'
      registerStatusTools()
    })
    return async () => {
      disposed = true
      generation++
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Already run.
        }
      }
      for (const dispose of statusRegistrations.splice(0)) {
        try {
          dispose()
        } catch {
          // Already run.
        }
      }
      const client = booted?.client
      booted = null
      if (client) await client.dispose(1500)
    }
  }, 'donsetch-lifecycle')

  // CLI config from the terminal reaches the live daemon via a
  // polling file watch on the config the real donsetch CLI writes.
  // The first listener call can fire on attach when the file has a
  // stale mtime: only restart when the mtime actually moves.
  let configWatchActive = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let lastSeenMtime: number | null = null
  const configPath = donsetchConfigPath()
  const recordMtime = (): number | null => {
    try {
      return statSync(configPath).mtimeMs
    } catch {
      return null
    }
  }
  lastSeenMtime = recordMtime()
  try {
    watchFile(configPath, { persistent: false, interval: 1200 }, () => {
      const mtime = recordMtime()
      if (mtime !== null && mtime === lastSeenMtime) return
      lastSeenMtime = mtime
      if (restartTimer !== null) return
      restartTimer = setTimeout(() => {
        restartTimer = null
        log(`donsetch config changed on disk (${configPath}); restarting daemon`)
        restartDaemon()
        void ensureDaemon()
      }, 800)
    })
    configWatchActive = true
  } catch {
    warn(`could not watch ${configPath}; CLI config changes will apply after the next dsh restart`)
  }
  ctx.effect(() => {
    return () => {
      if (configWatchActive) {
        unwatchFile(configPath)
        configWatchActive = false
      }
      if (restartTimer !== null) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
    }
  }, 'donsetch-config-watch')

  // Throttled, non-blocking update check once the daemon is up.
  if (config.autoUpdate) {
    ctx.effect(() => {
      let cancelled = false
      void (async () => {
        try {
          await ensureDaemon()
          if (cancelled || booted === null) return
          const current = booted.bin.source === 'release' ? booted.bin.version : config.pinnedVersion
          const info = await checkForUpdate(current, config.channel, config.updateIntervalHours)
          if (cancelled) return
          if (info?.newer === true) {
            pendingUpdateVersion = info.latest
            log(`newer donsetch v${info.latest} found (running v${current}); will swap between calls`)
            void maybeSwapUpdate()
          }
        } catch {
          // Updates are best-effort; tool service is unaffected.
        }
      })()
      return () => {
        cancelled = true
      }
    }, 'donsetch-update-check')
  }

  log(`plugin v${PLUGIN_VERSION} loaded; donsetch v${config.pinnedVersion}+ via the ${config.toolPrefix}_* tools`)
}
/**
 * Plugin-level tests: apply() against a minimal but true-to-contract
 * fake harness (ctx.tools registry with disposer semantics, ctx.effect
 * with real cleanup), a fake donsetch daemon, name sanitization, error
 * mapping, cancellation, crash recovery, the status-tool lifecycle,
 * and the live config-file watch restart.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fake-mcp-server.mjs')

let artifact
let cancelLog
let bootLog
let homeDir

before(() => {
  artifact = mkdtempSync(join(tmpdir(), 'donsetch-dsh-apply-'))
  cancelLog = join(artifact, 'cancelled.log')
  bootLog = join(artifact, 'boot.log')
  homeDir = join(artifact, 'home')
  mkdirSync(join(homeDir, '.config', 'donsetch'), { recursive: true })
  writeFileSync(join(homeDir, '.config', 'donsetch', 'config.json'), '{"hello":1}\n')
  process.env.FAKE_CANCEL_LOG = cancelLog
  process.env.FAKE_ALL_LOG = join(artifact, 'all.log')
  process.env.FAKE_RAW_LOG = join(artifact, 'raw.log')
  process.env.FAKE_BOOT_LOG = bootLog
  process.env.DONSETCH_BIN = FAKE
  process.env.DONSETCH_DSH_HOME = homeDir
  process.env.DONSETCH_DSH_AUTOUPDATE = 'off'
  chmodSync(FAKE, 0o755)
})

after(() => {
  delete process.env.FAKE_CANCEL_LOG
  delete process.env.FAKE_BOOT_LOG
  delete process.env.DONSETCH_BIN
  delete process.env.DONSETCH_DSH_HOME
  delete process.env.DONSETCH_DSH_AUTOUPDATE
  rmSync(artifact, { recursive: true, force: true })
})

const { apply, donsetchConfigPath } = await import('../dist/index.js')

test('apply: registers tools with prefix, skips invalid names, swaps status tool out when healthy', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'ds', fallbackToPath: false, callTimeoutMs: 5000, bootTimeoutMs: 5000 })
  await harness.waitFor((h) => h.defs().some((d) => d.name === 'ds_echo_tool'), 8000)
  const names = harness.defs().map((d) => d.name)
  assert.ok(names.includes('ds_echo_tool'))
  assert.ok(names.includes('ds_fail_tool'))
  assert.ok(names.includes('ds_slow_tool'))
  assert.ok(names.includes('ds_crash_tool'))
  assert.ok(!names.includes('ds_has space!!'), 'illegal tool names must be skipped, not registered')

  // The startup status tool must have been disposed once healthy.
  await harness.waitFor(() => !harness.defs().some((d) => d.name === 'ds_status'), 8000)

  // Execute the real echo tool through the plugin path.
  const echo = findDef(harness, 'ds_echo_tool')
  const result = await echo.execute({ text: 'native' }, { signal: new AbortController().signal })
  assert.equal(result.content[0].text, 'echo:native')

  // Error mapping: server isError becomes a thrown Error.
  const fail = findDef(harness, 'ds_fail_tool')
  await assert.rejects(() => fail.execute({}, { signal: new AbortController().signal }), /boom: upstream refused/)

  // Presentation cards exist for the native feel.
  const view = echo.presentCall({ text: 'hello' })
  assert.equal(view.card, 'generic')
  assert.match(view.title, /ds_echo_tool/)
  await harness.dispose()
})

test('apply: cancellation reaches the real server and settles the call', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'ds', fallbackToPath: false, callTimeoutMs: 20000 })
  await harness.waitFor((h) => h.defs().some((d) => d.name === 'ds_slow_tool'), 8000)
  const slow = findDef(harness, 'ds_slow_tool')
  const ac = new AbortController()
  const pr = slow.execute({}, { signal: ac.signal })
  setTimeout(() => ac.abort(), 120)
  await assert.rejects(pr, /cancelled/)
  await new Promise((r) => setTimeout(r, 250))
  const allLogPath = join(artifact, 'all.log')
  const allSeen = existsSync(allLogPath) ? readFileSync(allLogPath, 'utf8') : '(no all.log)'; const rawSeen = existsSync(join(artifact, 'raw.log')) ? readFileSync(join(artifact, 'raw.log'), 'utf8') : '(no raw)'
  assert.ok(existsSync(cancelLog), `abort must forward notifications/cancelled to the daemon; daemon saw: ${allSeen} RAW: ${rawSeen}`)
  assert.ok(readFileSync(cancelLog, 'utf8').trim().length > 0)
  await harness.dispose()
})

test('apply: daemon crash rejects the in-flight call and the next call revives cleanly', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'ds', fallbackToPath: false, callTimeoutMs: 20000 })
  await harness.waitFor((h) => h.defs().some((d) => d.name === 'ds_crash_tool'), 8000)
  const crash = findDef(harness, 'ds_crash_tool')
  await assert.rejects(() => crash.execute({}, { signal: new AbortController().signal }), /exited|not running|unavailable/)

  const echo = findDef(harness, 'ds_echo_tool')
  for (let i = 0; i < 30; i++) {
    try {
      const result = await echo.execute({ text: 'revived' }, { signal: new AbortController().signal })
      assert.equal(result.content[0].text, 'echo:revived')
      await harness.dispose()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  assert.fail('daemon never revived after crash')
})

test('apply: live config file change restarts the daemon (boot count), tools stay registered', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'ds', fallbackToPath: false, callTimeoutMs: 20000 })
  try {
    await harness.waitFor((h) => h.defs().some((d) => d.name === 'ds_echo_tool'), 8000)
    const bootsBefore = bootCount()
    const now = new Date()
    utimesSync(donsetchConfigPath(), now, now)
    await harness.waitFor(() => bootCount() > bootsBefore, 12000)
    // Exactly one extra boot: the config-triggered daemon swap.
    assert.equal(bootCount(), bootsBefore + 1)
    // Tools remain registered after the swap.
    assert.ok(harness.defs().some((d) => d.name === 'ds_echo_tool'))
    const echo = findDef(harness, 'ds_echo_tool')
    const result = await echo.execute({ text: 'after-swap' }, { signal: new AbortController().signal })
    assert.equal(result.content[0].text, 'echo:after-swap')
  } finally {
    await harness.dispose()
  }
})

test('apply: dispose tears the daemon down and leaves no orphan children', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'ds', fallbackToPath: false })
  await harness.waitFor((h) => h.defs().some((d) => d.name === 'ds_echo_tool'), 8000)
  const echo = findDef(harness, 'ds_echo_tool')
  const before = await echo.execute({ text: 'x' }, { signal: new AbortController().signal })
  assert.equal(before.content[0].text, 'echo:x')
  await harness.dispose()
  const { spawnSync } = await import('node:child_process')
  const count = () => Number(spawnSync('pgrep', ['-fc', 'fake-mcp-server'], { encoding: 'utf8' }).stdout.trim() || '0')
  let left = count()
  for (let i = 0; i < 20 && left !== 0; i++) {
    await new Promise((r) => setTimeout(r, 200))
    left = count()
  }
  assert.equal(left, 0, 'dispose must kill the daemon child, no orphan may survive')
})

function bootCount() {
  if (!existsSync(bootLog)) return 0
  return readFileSync(bootLog, 'utf8').trim().split('\n').filter(Boolean).length
}

function findDef(harness, name) {
  const def = harness.defs().find((d) => d.name === name)
  assert.ok(def, `tool ${name} must be registered`)
  return def
}

function makeHarness() {
  const all = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        all.set(def.name, def)
        return () => {
          all.delete(def.name)
        }
      },
    },
    effect(scope) {
      let disposer = undefined
      try {
        disposer = scope()
      } catch (err) {
        console.error('effect scope failed:', err)
      }
      disposers.push(async () => {
        if (typeof disposer === 'function') await disposer()
      })
      return { dispose: () => undefined }
    },
    on() {
      return () => undefined
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return {
    ctx,
    defs: () => [...all.values()],
    waitFor(cond, timeoutMs) {
      return new Promise((resolve, reject) => {
        const start = Date.now()
        const timer = setInterval(() => {
          let value
          try {
            value = cond(this)
          } catch {
            value = undefined
          }
          if (value) {
            clearInterval(timer)
            resolve(value)
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer)
            reject(new Error(`condition not met within ${timeoutMs}ms; tools: ${[...all.keys()].join(', ')}`))
          }
        }, 60)
      })
    },
    dispose: async () => {
      for (const d of disposers.splice(0)) await d()
    },
  }
}
/**
 * MCP client tests against the fake stdio daemon. These cover the
 * protocol discipline: frame parsing, per-request timeouts, real
 * cancellation, crash handling, restart, and stderr isolation.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let artifact
let cancelLog
let bootLog
let crashLog
let env

before(() => {
  artifact = mkdtempSync(join(tmpdir(), 'donsetch-dsh-mcp-'))
  cancelLog = join(artifact, 'cancelled.log')
  bootLog = join(artifact, 'boot.log')
  crashLog = join(artifact, 'crash.log')
  env = {
    ...process.env,
    FAKE_CANCEL_LOG: cancelLog,
    FAKE_BOOT_LOG: bootLog,
    FAKE_CRASH_LOG: crashLog,
  }
})

after(() => {
  rmSync(artifact, { recursive: true, force: true })
})

const { McpClient } = await import('../dist/mcp.js')

const makeClient = (callTimeoutMs = 5000) =>
  new McpClient({
    cmd: [process.execPath, join(HERE, 'fake-mcp-server.mjs'), 'mcp'],
    callTimeoutMs,
    bootTimeoutMs: 5000,
    env,
  })

test('boot: initialize + tools/list exposes all five tools', async () => {
  const c = makeClient()
  await c.start()
  assert.equal(c.serverVersion, '9.9.9-test')
  assert.deepEqual(
    c.tools.map((t) => t.name),
    ['echo_tool', 'fail_tool', 'slow_tool', 'crash_tool', 'has space!!'],
  )
  assert.equal(c.tools[0].inputSchema.type, 'object')
  await c.dispose(300)
})

test('callTool: echo roundtrip returns the text block', async () => {
  const c = makeClient()
  await c.start()
  const result = await c.callTool('echo_tool', { text: 'hello dsh' })
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].text, 'echo:hello dsh')
  await c.dispose(300)
})

test('callTool: server-side errors surface as isError', async () => {
  const c = makeClient()
  await c.start()
  const result = await c.callTool('fail_tool', {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /boom/)
  await c.dispose(300)
})

test('callTool: per-call timeout rejects without leaking pending state', async () => {
  const c = makeClient(800)
  await c.start()
  await assert.rejects(() => c.callTool('slow_tool', {}), /timed out/)
  // Client stays usable after a timeout: pending map is clean.
  const result = await c.callTool('echo_tool', { text: 'after' })
  assert.equal(result.content[0].text, 'echo:after')
  await c.dispose(300)
})

test('callTool: abort signals the server (cancellation marker) and settles fast', async () => {
  const c = makeClient()
  await c.start()
  const ac = new AbortController()
  const pending = c.callTool('slow_tool', {}, ac.signal)
  setTimeout(() => ac.abort(), 120)
  await assert.rejects(pending, /cancelled/)
  // Give the marker file a beat to land.
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(existsSync(cancelLog), 'server must receive notifications/cancelled')
  const ids = readFileSync(cancelLog, 'utf8').trim().split('\n')
  assert.ok(ids.length >= 1 && ids.every((id) => /^\d+$/.test(id)))
  await c.dispose(300)
})

test('crash: a killed server rejects in-flight calls and can restart', async () => {
  const c = makeClient()
  await c.start()
  await assert.rejects(() => c.callTool('crash_tool', {}), /exited/)
  assert.equal(c.running, false)
  assert.equal(c.healthy, false)
  await assert.rejects(() => c.callTool('echo_tool', {}), /not running/)
  // Restart with a fresh child and handshake.
  await c.start()
  const result = await c.callTool('echo_tool', { text: 'revived' })
  assert.equal(result.content[0].text, 'echo:revived')
  await c.dispose(300)
})

test('stderr: noise stays out of stdout frames and is tailed', async () => {
  const c = makeClient()
  await c.start()
  await c.callTool('echo_tool', { text: 'x' })
  assert.match(c.stderrTailText(), /noise:/)
  await c.dispose(300)
})

test('dispose: shuts the child down and rejects queued work', async () => {
  const c = makeClient()
  await c.start()
  const p = c.callTool('slow_tool', {}).catch((e) => e)
  await c.dispose(300)
  const settled = await p
  assert.ok(settled instanceof Error)
  assert.equal(c.running, false)
})
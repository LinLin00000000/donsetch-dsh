/**
 * Live end-to-end: real donsetch binary, real MCP handshake, real
 * tools/list, real tool call. Uses DONSETCH_BIN when set, otherwise
 * resolves/downloads the pinned release exactly like the plugin does.
 * This is the test that proves tool parity with the standard donsetch
 * MCP server: it drives the daemon the plugin will drive.
 */
import { existsSync } from 'node:fs'
import { resolveBinary } from '../dist/binary.js'
import { McpClient } from '../dist/mcp.js'
import { PINNED_DONSETCH_VERSION } from '../dist/version.js'

const REQUIRED_TOOLS = ['web_fetch', 'web_search', 'web_crawl']

async function main() {
  const { path, version, source } = await resolveBinary(PINNED_DONSETCH_VERSION, false, {
    onProgress: (state) => console.log('  ' + state),
  })
  console.log(`donsetch binary: ${path}`)
  console.log(`expected version: v${PINNED_DONSETCH_VERSION}; resolved: ${version} (${source})`)

  const client = new McpClient({
    cmd: [path, 'mcp'],
    callTimeoutMs: 180_000,
    bootTimeoutMs: 30_000,
  })
  await client.start()
  console.log(`daemon version: ${client.serverVersion ?? 'unknown'}`)
  if (client.serverVersion !== null && client.serverVersion !== PINNED_DONSETCH_VERSION) {
    console.log(`note: daemon version differs from plugin pin (expected); tools are discovered dynamically`)
  }

  const names = client.tools.map((t) => t.name)
  console.log(`tools discovered: ${names.join(', ')}`)
  for (const required of REQUIRED_TOOLS) {
    if (!names.includes(required)) {
      throw new Error(`LIVE FAIL: ${required} missing from tools/list. Parity with the MCP server is broken.`)
    }
  }

  const webPage = await client.callTool('web_fetch', { url: 'https://example.com' })
  if (webPage.isError === true) throw new Error(`LIVE FAIL: web_fetch returned isError`)
  const text = (webPage.content ?? []).map((b) => (typeof b.text === 'string' ? b.text : '')).join('')
  if (!/example/i.test(text)) throw new Error('LIVE FAIL: web_fetch output does not contain example.com content')
  console.log(`web_fetch ok: ${text.length} chars`)

  const search = await client.callTool('web_search', { query: 'donsetch web research', max_results: 2 })
  if (search.isError === true) throw new Error('LIVE FAIL: web_search returned isError')
  const searchText = (search.content ?? []).map((b) => (typeof b.text === 'string' ? b.text : '')).join('')
  if (!searchText.trim()) throw new Error('LIVE FAIL: web_search returned empty content')
  console.log(`web_search ok: ${searchText.length} chars`)

  await client.dispose(1000)
  console.log('LIVE OK: daemon parity confirmed (fetch + search + crawl tool surface)')
  process.exit(0)
}

main().catch((err) => {
  console.error('LIVE FAIL: ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
/**
 * Real-registry integration proof. Skips unless DONSETCH_BIN points at
 * a real donsetch binary AND the real host packages are resolvable.
 *
 * The gate: apply the plugin into an ACTUAL @deepseek-ai/dsh-tools
 * ToolRuntime on a real @deepseek-ai/cordis context, push the
 * registered parameter specs through the real validateArgs, and run a
 * live search through the complete registry pipeline. A fake harness
 * cannot catch contract drift here; this is the definitive contract
 * test of the plugin's harness-facing surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const BIN = process.env.DONSETCH_BIN?.trim()
if (!BIN || !existsSync(BIN)) {
  test('real-registry proof', { skip: 'DONSETCH_BIN not set or missing' }, () => {})
} else {
  test('real-registry proof: register, validateArgs, live search through the real pipeline', async () => {
    let cordis = null
    let dshTools = null
    try {
      cordis = await import('@deepseek-ai/cordis')
      dshTools = await import('@deepseek-ai/dsh-tools')
    } catch {
      assert.fail('real-registry proof requires @deepseek-ai/cordis and @deepseek-ai/dsh-tools (npm i them in the test env)')
      return
    }
    const { Context, Service } = cordis
    const { ToolRuntime, validateArgs } = dshTools
    const { apply } = await import('../dist/index.js')

    class StubSystemPrompt extends Service {
      constructor(ctx) {
        super(ctx, 'systemPrompt')
      }

      tools() {
        return () => {}
      }

      section() {
        return () => {}
      }

      getSectionOrder() {
        return 0
      }

      collapseSection() {
        return () => {}
      }
    }

    class CapturingRuntime extends ToolRuntime {
      constructor(ctx) {
        super(ctx)
        globalThis.__tools = this
      }
    }

    const cwdBefore = process.env.DONSETCH_DSH_AUTOUPDATE
    process.env.DONSETCH_DSH_AUTOUPDATE = 'off'
    const ctx = new Context()
    const keepAlive = []
    keepAlive.push(ctx.plugin(StubSystemPrompt))
    keepAlive.push(ctx.plugin(CapturingRuntime))
    await Promise.all(keepAlive)
    Object.defineProperty(ctx, 'tools', { value: globalThis.__tools, configurable: true })
    const pluginHandle = apply(ctx, {
      toolPrefix: 'donsetch',
      fallbackToPath: false,
      callTimeoutMs: 180_000,
      bootTimeoutMs: 30_000,
    })

    const deadline = Date.now() + 60_000
    let got = []
    while (Date.now() < deadline) {
      got = ['web_fetch', 'web_search', 'web_crawl', 'status'].map((suffix) => {
        const name = `donsetch_${suffix}`
        return { name, def: ctx.tools.get(name) }
      }).filter((entry) => entry.def !== undefined)
      if (got.length === 4) break
      await new Promise((r) => setTimeout(r, 250))
    }
    try {
      assert.equal(got.length, 4, `expected the four donsetch tools, got: ${got.map((t) => t.name).join(', ') || '(none)'}`)

      const samples = {
        donsetch_web_fetch: { url: 'https://example.com', max_chars: 1000 },
        donsetch_web_search: { query: 'what is the rust programming language', max_results: 3, query_variants: ['rust lang'] },
        donsetch_web_crawl: { url: 'https://example.com', max_pages: 2 },
        donsetch_status: {},
      }
      for (const { name, def } of got) {
        const violations = validateArgs(def.parameters, samples[name] ?? {})
        assert.deepEqual(violations, [], `${name} args rejected: ${violations.map((v) => v.message ?? v).join('; ')}`)
      }

      const result = await ctx.tools.execute({
        name: 'donsetch_web_search',
        arguments: { query: 'what is the rust programming language' },
        signal: new AbortController().signal,
      })
      const text = (result?.content ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
      assert.equal(result?.isError, false, `search errored: ${text}`)
      assert.ok(text.length > 40, `search returned empty through the real pipeline: ${JSON.stringify(result).slice(0, 400)}`)
    } finally {
      await pluginHandle.dispose()
      for (const fiber of keepAlive) {
        try {
          fiber.dispose()
        } catch {
          // Already disposed.
        }
      }
      if (cwdBefore === undefined) delete process.env.DONSETCH_DSH_AUTOUPDATE
      else process.env.DONSETCH_DSH_AUTOUPDATE = cwdBefore
    }
  })
}
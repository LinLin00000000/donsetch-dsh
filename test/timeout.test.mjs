/**
 * Per-call timeout derivation. The plugin configures one callTimeoutMs
 * for every tools/call, but the binary's own budgets are larger than it:
 * web_crawl accepts deadline_s up to 600 and web_fetch deadline_ms up to
 * 600000. A legal call was killed client-side while the server was still
 * inside its documented deadline, and the crawl default (120s) already
 * sat inside the 180s default, racing it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { callTimeoutFor } = await import('../dist/index.js')

const BASE = 180_000

test('a call with no budget keeps the configured timeout', () => {
  assert.equal(callTimeoutFor('web_search', { query: 'x' }, BASE), BASE)
  assert.equal(callTimeoutFor('web_fetch', { url: 'https://x.test' }, BASE), BASE)
  assert.equal(callTimeoutFor('web_screenshot', { url: 'https://x.test' }, BASE), BASE)
})

test('a crawl budget overrides the client timeout', () => {
  // deadline_s 600 is legal per the schema; it used to be cut at 180s.
  assert.equal(callTimeoutFor('web_crawl', { url: 'u', deadline_s: 600 }, BASE), 620_000)
  assert.equal(callTimeoutFor('web_crawl', { url: 'u', deadline_s: 30 }, BASE), 50_000)
})

test('a crawl with no deadline still outlives the server default', () => {
  // The binary defaults deadline_s to 120; the client must clear that
  // plus slack instead of landing on top of it.
  assert.equal(callTimeoutFor('web_crawl', { url: 'u' }, BASE), 140_000)
})

test('a fetch budget overrides, and the cap holds', () => {
  assert.equal(callTimeoutFor('web_fetch', { url: 'u', deadline_ms: 600_000 }, BASE), 620_000)
  assert.equal(callTimeoutFor('web_fetch', { url: 'u', deadline_ms: 999_999_999 }, BASE), 620_000)
})

test('unusable budgets fall back to the binary default, not to zero', () => {
  // A junk deadline_s means the server will use its 120s default.
  assert.equal(callTimeoutFor('web_crawl', { url: 'u', deadline_s: 'soon' }, BASE), 140_000)
  // A junk or negative deadline_ms means no budget was requested.
  assert.equal(callTimeoutFor('web_fetch', { url: 'u', deadline_ms: 'soon' }, BASE), BASE)
  assert.equal(callTimeoutFor('web_fetch', { url: 'u', deadline_ms: -5 }, BASE), BASE)
})

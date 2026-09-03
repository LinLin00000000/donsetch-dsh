/**
 * Binary provisioning tests against a local HTTP fixture: the full
 * download, SHA256 verification, extraction and cache lifecycle, plus
 * every failure mode that must refuse to install. The fixture serves
 * tarball + .sha256 sidecar exactly like GitHub Releases does.
 *
 * NOTE: the vendored http layer under test uses node:http internally,
 * so the fixture runs the same stack end to end (no undici sockets to
 * pin the runner: every request drains or is destroyed).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let artifact
let cacheRoot
let goodTarball
let goodHash
let tamperedTarball
let server
let tarballHits = 0
let serveMode = 'good'
let serveMissingSidecar = false
const servedVersions = new Set(['3.5.2', '3.5.3', '3.5.4', '3.5.5'])
let binaryApi

before(async () => {
  artifact = mkdtempSync(join(tmpdir(), 'donsetch-dsh-bin-'))
  cacheRoot = join(artifact, 'cache')
  const payload = '#!/bin/sh\necho fake-donsetch\n'
  const stage = mkdtempSync(join(artifact, 'stage-'))
  mkdirSync(join(stage, 'pkg'), { recursive: true })
  binaryApi = await import('../dist/binary.js')

  const platform = binaryApi.PLATFORM
  const binaryName = platform.key === 'win32-x64' ? 'donsetch.exe' : 'donsetch'
  goodTarball = join(artifact, 'good.tar.gz')
  writeFileSync(join(stage, 'pkg', binaryName), payload)
  execFileSync('tar', ['-czf', goodTarball, '-C', join(stage, 'pkg'), '.'])
  goodHash = createHash('sha256').update(readFileSync(goodTarball)).digest('hex')

  tamperedTarball = join(artifact, 'tampered.tar.gz')
  writeFileSync(tamperedTarball, 'this is not a tarball at all')

  server = createServer((req, res) => {
    const versionMatch = /^\/v([^/]+)\//.exec(req.url)
    if (versionMatch && !servedVersions.has(versionMatch[1])) {
      res.statusCode = 404
      res.end('release not found')
      return
    }
    if (req.url.endsWith('.tar.gz.sha256')) {
      if (serveMissingSidecar) {
        res.statusCode = 404
        res.end('nope')
        return
      }
      res.setHeader('content-type', 'text/plain')
      res.end(goodHash + '  donsetch-linux-x64.tar.gz\n')
      return
    }
    if (req.url.endsWith('.tar.gz')) {
      tarballHits++
      const body = serveMode === 'tampered' ? readFileSync(tamperedTarball) : readFileSync(goodTarball)
      res.setHeader('content-type', 'application/gzip')
      res.end(body)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.DONSETCH_DSH_RELEASES_BASE = `http://127.0.0.1:${server.address().port}`
  process.env.DONSETCH_DSH_CACHE_DIR = cacheRoot
})

after(async () => {
  delete process.env.DONSETCH_DSH_RELEASES_BASE
  delete process.env.DONSETCH_DSH_CACHE_DIR
  await new Promise((resolve) => server.close(resolve))
  rmSync(artifact, { recursive: true, force: true })
})

test('downloadBinary: happy path verifies, extracts, chmods, caches', async () => {
  const { downloadBinary, installedVersions, PLATFORM } = binaryApi
  const path = await downloadBinary('3.5.2', { timeoutMs: 15000 })
  assert.ok(path.endsWith(`/bin/3.5.2/${PLATFORM.key === 'win32-x64' ? 'donsetch.exe' : 'donsetch'}`))
  assert.ok(existsSync(path))
  if (process.platform !== 'win32') {
    assert.ok(statSync(path).mode & 0o100, 'binary must be executable')
  }
  assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\necho fake-donsetch\n')
  assert.equal(installedVersions().length, 1)
  // Idempotent: second call short-circuits on the cached install.
  const again = await downloadBinary('3.5.2', { timeoutMs: 15000 })
  assert.equal(again, path)
})

test('downloadBinary: SHA256 mismatch refuses to install and leaves no cache entry', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  serveMode = 'tampered'
  await assert.rejects(() => downloadBinary('3.5.4', { timeoutMs: 15000 }), /SHA256 mismatch/)
  assert.equal(existsSync(binaryAt('3.5.4')), false)
  serveMode = 'good'
})

test('downloadBinary: missing sidecar refuses to install', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  serveMissingSidecar = true
  await assert.rejects(() => downloadBinary('3.5.5', { timeoutMs: 15000 }), /unverifiable/)
  assert.equal(existsSync(binaryAt('3.5.5')), false)
  serveMissingSidecar = false
})

test('downloadBinary: non-semver version is refused before any network work', async () => {
  const { downloadBinary } = binaryApi
  await assert.rejects(() => downloadBinary('latest', { timeoutMs: 15000 }), /not a valid semver/)
  await assert.rejects(() => downloadBinary('3.5.2; rm -rf /', { timeoutMs: 15000 }), /not a valid semver/)
})

test('downloadBinary: missing release gets the actionable platform list', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  await assert.rejects(() => downloadBinary('9.9.9', { timeoutMs: 15000 }), /does not ship a .* binary/)
  assert.equal(existsSync(binaryAt('9.9.9')), false)
})

test('concurrent downloads: one install, no torn cache', async () => {
  const { downloadBinary, installedVersions } = binaryApi
  tarballHits = 0
  const [a, b] = await Promise.all([
    downloadBinary('3.5.3', { timeoutMs: 15000 }),
    downloadBinary('3.5.3', { timeoutMs: 15000 }),
  ])
  assert.equal(a, b)
  assert.ok(existsSync(a))
  assert.equal(installedVersions().length, 2) // 3.5.2 + 3.5.3
})

test('resolveBinary: newest cached install wins over the pinned floor', async () => {
  const { resolveBinary } = binaryApi
  const resolved = await resolveBinary('3.5.2', false, { timeoutMs: 15000 })
  assert.equal(resolved.source, 'release')
  assert.match(resolved.version, /^3\.5\./)
})

test('resolveBinary: DONSETCH_BIN override wins over cache', async () => {
  const { resolveBinary } = binaryApi
  const sentinel = join(artifact, 'sentinel-bin')
  writeFileSync(sentinel, '#!/bin/sh\n')
  process.env.DONSETCH_BIN = sentinel
  try {
    const resolved = await resolveBinary('3.5.2', false, { timeoutMs: 15000 })
    assert.equal(resolved.path, sentinel)
    assert.equal(resolved.source, 'path')
  } finally {
    delete process.env.DONSETCH_BIN
  }
})
/**
 * Structural verification of the packed tarball: what a `dsh plugin
 * add` (pnpm git/tarball install) will resolve. Checks the manifest's
 * dsh.bundle declaration, the patch file it points at, that every
 * `files` entry exists, and that the entry module exports the plugin
 * contract (name + apply).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'donsetch-pack-'))
let out
try {
  execFileSync('npm', ['pack', '--pack-destination', dir, '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('npm pack produced no tarball')
  out = join(dir, 'out')
  mkdirSync(out, { recursive: true })
  execFileSync('tar', ['-xzf', join(dir, tgz), '-C', out])

  const pkg = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8'))
  if (pkg.name !== '@dsh-external/donsetch') throw new Error('package name mismatch: ' + pkg.name)
  if (!pkg.dsh?.bundle?.patch) throw new Error('package.json is missing dsh.bundle.patch')
  const patchRel = pkg.dsh.bundle.patch.replace(/^\.\//, '')
  if (!existsSync(join(out, 'package', patchRel))) throw new Error(`patch file ${patchRel} missing from tarball`)
  const patch = readFileSync(join(out, 'package', patchRel), 'utf8')
  if (!patch.includes("'@dsh-external/donsetch'") && !patch.includes('"@dsh-external/donsetch"')) {
    throw new Error('patch does not mount the plugin package name')
  }
  for (const entry of pkg.files ?? []) {
    if (!existsSync(join(out, 'package', entry))) throw new Error(`files entry ${entry} missing from tarball`)
  }
  const mainEntry = (pkg.main ?? './dist/index.js').replace(/^\.\//, '')
  if (!existsSync(join(out, 'package', mainEntry))) throw new Error(`main entry ${mainEntry} missing from tarball`)
  const mod = await import('file://' + join(out, 'package', mainEntry))
  if (typeof mod.apply !== 'function' || typeof mod.name !== 'string') {
    throw new Error('entry module does not export { name, apply }')
  }
  console.log('PACK OK: manifest, patch, files, and entry contract verified')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
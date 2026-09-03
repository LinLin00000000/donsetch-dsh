/**
 * House-style lint: no em-dash characters in any shipped text. The
 * public-text rule from the donsetch repo. Fails the build if one
 * sneaks into code, docs, tests, or workflow files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.cache'])
const SKIP_EXT = new Set(['.tgz', '.png', '.jpg', '.lock'])

const hits = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full)
      continue
    }
    const ext = entry.slice(entry.lastIndexOf('.'))
    if (SKIP_EXT.has(ext)) continue
    const text = readFileSync(full, 'utf8')
    let idx = text.indexOf('\u2014')
    while (idx !== -1) {
      const line = text.slice(0, idx).split('\n').length
      hits.push(`${relative(ROOT, full)}:${line}`)
      idx = text.indexOf('\u2014', idx + 1)
    }
  }
}

walk(ROOT)
if (hits.length > 0) {
  console.error('em-dash characters found (public-text rule):')
  for (const hit of hits) console.error('  ' + hit)
  process.exit(1)
}
console.log('lint: no em-dashes')
process.exit(0)
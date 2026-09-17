#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'

const repo = 'dondai44423/donsetch'
const requested = process.argv[2]?.trim()

async function latestTag() {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'donsetch-dsh-pin-bumper',
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub latest-release request failed: HTTP ${response.status}`)
  }
  const body = await response.json()
  if (typeof body.tag_name !== 'string') {
    throw new Error('GitHub latest-release response has no tag_name')
  }
  return body.tag_name
}

const tag = requested || await latestTag()
const version = tag.startsWith('v') || tag.startsWith('V') ? tag.slice(1) : tag
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`invalid DonSeTch release version: ${tag}`)
}

const sourcePath = new URL('../src/version.ts', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const pinPattern = /(export const PINNED_DONSETCH_VERSION = ')[^']+(')/
const match = source.match(pinPattern)
if (!match) {
  throw new Error('could not find PINNED_DONSETCH_VERSION in src/version.ts')
}

const current = match[0].match(/'([^']+)'/)?.[1]
if (current === version) {
  console.log(`already at ${version}`)
  process.exit(0)
}

await writeFile(sourcePath, source.replace(pinPattern, `$1${version}$2`))
console.log(`updated DonSeTch pin ${current} -> ${version}`)

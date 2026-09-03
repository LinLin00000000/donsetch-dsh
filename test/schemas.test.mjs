/**
 * Parameter transform tests against both the real donsetch daemon
 * schemas (fixtures captured from the shipped 3.5.2 binary) and a
 * keyword matrix of hostile inputs. Everything must project to the
 * dsh implicit parameter schema and pass the mirror, and the
 * conversions must be lossless where the dialect allows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { toDshSpec, specViolation } = await import('../dist/schemas.js')

function assertSpec(spec) {
  const violation = specViolation(spec)
  assert.equal(violation, null, `spec violates the contract: ${violation}\n${JSON.stringify(spec, null, 2)}`)
}

function daemonTools() {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', 'daemon-tools.json'), 'utf8'))
}

test('spec: every real daemon inputSchema projects into the parameter schema', () => {
  const tools = daemonTools()
  assert.ok(tools.length >= 3)
  for (const tool of tools) {
    const spec = toDshSpec(tool.inputSchema)
    assertSpec(spec)
    assert.ok(Object.keys(spec).length > 0, `${tool.name} spec must not be empty`)
  }
})

test('spec: web_fetch url anyOf becomes a oneOf value schema', () => {
  const fetchTool = daemonTools().find((t) => t.name === 'web_fetch')
  const spec = toDshSpec(fetchTool.inputSchema)
  const url = spec.url
  assert.ok(Array.isArray(url.oneOf) && url.oneOf.length === 2, 'url keeps both anyOf branches as oneOf')
  const arrayBranch = url.oneOf.find((b) => b.type === 'array')
  assert.equal(arrayBranch.items.type, 'string')
  assert.ok(!Object.hasOwn(url, 'type'), 'oneOf must not carry a type')
  assertSpec(spec)
})

test('spec: web_search required flag maps from the schema required array', () => {
  const searchSpec = toDshSpec(daemonTools().find((t) => t.name === 'web_search').inputSchema)
  assert.equal(searchSpec.query.type, 'string')
  assert.equal(searchSpec.query.required, true, 'query is required in the daemon schema')
  assert.equal(searchSpec.max_results.type, 'integer')
  assert.ok(!Object.hasOwn(searchSpec, 'required'), 'no required array may leak into the spec')
  assertSpec(searchSpec)
})

test('spec: unsupported keywords are dropped, not smuggled, with the constraint noted', () => {
  const hostile = {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 3, pattern: '^[a-z]+$', format: 'uri', readOnly: true, default: 'x' },
      n: { type: 'integer', minimum: 1, maximum: 50 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 5, uniqueItems: true },
      fixed: { const: 'locked', type: 'string' },
      vec: { type: 'array', items: { type: 'number' }, valuetyped: undefined },
    },
    required: ['q', 'n', 'tags'],
    additionalProperties: false,
  }
  const spec = toDshSpec(hostile)
  assertSpec(spec)
  assert.equal(spec.q.type, 'string')
  assert.equal(spec.q.required, true)
  assert.match(spec.q.description, /minLength 3/)
  assert.match(spec.q.description, /pattern/)
  assert.equal(spec.n.type, 'integer')
  assert.ok(!Object.hasOwn(spec.n, 'minimum') && !Object.hasOwn(spec.n, 'maximum'))
  assert.equal(spec.n.required, true)
  assert.equal(spec.tags.type, 'array')
  assert.equal(spec.tags.items.type, 'string')
  assert.ok(!Object.hasOwn(spec.tags, 'maxItems'), 'maxItems must be dropped from the node')
  assert.match(spec.tags.description, /maxItems 5/)
  assert.equal(spec.tags.required, true)
  assert.equal(spec.fixed.type, 'string')
  assert.deepEqual(spec.fixed.const, 'locked')
  assert.equal(spec.vec.type, 'array')
})

test('spec: object mapping is explicit with additionalProperties and nested required', () => {
  const input = {
    type: 'object',
    properties: {
      opts: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['fast', 'deep'] }, depth: { type: 'integer' } },
        required: ['mode'],
        additionalProperties: false,
      },
    },
    required: ['opts'],
  }
  const spec = toDshSpec(input)
  assertSpec(spec)
  assert.equal(spec.opts.type, 'object')
  assert.equal(spec.opts.additionalProperties, false)
  assert.equal(spec.opts.required, true)
  assert.equal(spec.opts.properties.mode.required, true, 'nested required flags carry down')
  assert.deepEqual(spec.opts.properties.mode.enum, ['fast', 'deep'])
  assert.ok(!Object.hasOwn(spec.opts.properties.depth, 'required'))
})

test('spec: scalar enum filtering by type and const over enum', () => {
  const input = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['a', 'b', 3, null] },
      when: { type: 'number', enum: [1, 'x', Number.POSITIVE_INFINITY] },
      lock: { type: 'string', enum: ['a'], const: 'a' },
    },
  }
  const spec = toDshSpec(input)
  assertSpec(spec)
  assert.deepEqual(spec.kind.enum, ['a', 'b'])
  assert.deepEqual(spec.when.enum, [1])
  assert.deepEqual(spec.lock.const, 'a')
  assert.ok(!Object.hasOwn(spec.lock, 'enum'), 'const replaces the redundant enum')
})

test('spec: unusable inputs degrade to an open json parameter', () => {
  for (const garbage of [null, 42, 'str', [], { type: 'object', properties: 'nope' }, { type: ['string', 'null'] }]) {
    const spec = toDshSpec(garbage)
    assertSpec(spec)
    assert.deepEqual(spec, { input: { type: 'json' } }, `garbage ${JSON.stringify(garbage)}`)
  }
})

test('spec: annotated-only or typeless property becomes type json', () => {
  const spec = toDshSpec({
    type: 'object',
    properties: { blob: { description: 'anything goes' }, mixed: {} },
    required: ['blob'],
  })
  assertSpec(spec)
  assert.equal(spec.blob.type, 'json')
  assert.equal(spec.blob.required, true)
  assert.equal(spec.mixed.type, 'json')
})

test('spec: oneOf branches must not carry required flags', () => {
  const spec = toDshSpec({
    type: 'object',
    properties: {
      target: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
    },
    required: ['target'],
  })
  assertSpec(spec)
  assert.equal(spec.target.required, true)
  for (const branch of spec.target.oneOf) {
    assert.ok(!Object.hasOwn(branch, 'required'), 'required only exists on property-map entries')
  }
})
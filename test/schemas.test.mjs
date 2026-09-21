/**
 * Parameter transform tests against both the real donsetch daemon
 * schemas (fixtures captured from the shipped 3.5.2 binary) and a
 * keyword matrix of hostile inputs. Everything must project to the
 * dsh implicit parameter schema and pass the mirror, and the
 * conversions must be lossless where the dialect allows.
 *
 * The second half covers the wire projection: register() does not
 * compile parameters, so what the plugin hands it must already be a
 * JSON Schema document or every provider rejects the whole request.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertWireSchema } from './wire-schema.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { toDshSpec, specToJsonSchema, specViolation } = await import('../dist/schemas.js')

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

// ---------------------------------------------------------------------------
// Wire projection: what register() actually receives.
// ---------------------------------------------------------------------------

test('wire: every real daemon tool projects into a JSON Schema document', () => {
  for (const tool of daemonTools()) {
    const wire = specToJsonSchema(toDshSpec(tool.inputSchema))
    assertWireSchema(wire, tool.name)
  }
})

test('wire: register() would forward a bare property map, so the root must be an object schema', () => {
  // The regression this whole transform exists for: the author form is a
  // property map, and register() copies it to the model verbatim, so a
  // provider sees `parameters: { url: {...} }` and rejects the request.
  const authorForm = toDshSpec({ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] })
  assert.ok(!Object.hasOwn(authorForm, 'type'), 'precondition: author form has no root type')
  const wire = specToJsonSchema(authorForm)
  assert.equal(wire.type, 'object')
  assert.ok(Object.hasOwn(wire.properties, 'url'))
  assert.deepEqual(wire.required, ['url'])
  assertWireSchema(wire, 'url tool')
})

test('wire: per-property required booleans become the parent required array at every depth', () => {
  const wire = specToJsonSchema(
    toDshSpec({
      type: 'object',
      properties: {
        opts: {
          type: 'object',
          properties: { mode: { type: 'string' }, depth: { type: 'integer' } },
          required: ['mode'],
          additionalProperties: false,
        },
        top: { type: 'string' },
      },
      required: ['opts'],
    }),
  )
  assert.deepEqual(wire.required, ['opts'], 'root required array from the property map')
  assert.equal(wire.properties.opts.type, 'object')
  assert.equal(wire.properties.opts.additionalProperties, false)
  assert.deepEqual(wire.properties.opts.required, ['mode'], 'nested required becomes an array too')
  assert.equal(typeof wire.properties.opts.required, 'object', 'required must be an array, never a boolean')
  assert.ok(!Object.hasOwn(wire.properties.opts.properties.mode, 'required'))
  assertWireSchema(wire, 'nested tool')
})

test('wire: a required property with oneOf keeps required on the parent, never beside oneOf', () => {
  const wire = specToJsonSchema(
    toDshSpec({
      type: 'object',
      properties: { target: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      required: ['target'],
    }),
  )
  assert.deepEqual(wire.required, ['target'])
  assert.equal(wire.properties.target.oneOf.length, 2)
  assert.ok(
    !Object.hasOwn(wire.properties.target, 'required'),
    'required is a forbidden sibling of oneOf in the raw subset',
  )
  assertWireSchema(wire, 'oneOf tool')
})

test('wire: object nodes always declare additionalProperties explicitly', () => {
  const wire = specToJsonSchema(toDshSpec({ type: 'object', properties: { opts: { type: 'object', properties: {} }, tags: { type: 'array', items: { type: 'string' } } } }))
  assert.equal(typeof wire.properties.opts.additionalProperties, 'boolean')
  assertWireSchema(wire, 'open object tool')
})

test('wire: the author-only json node becomes an unconstrained (annotation-only) schema', () => {
  const wire = specToJsonSchema(toDshSpec({ type: 'object', properties: { blob: { description: 'anything goes' } } }))
  assert.deepEqual(wire.properties.blob, { description: 'anything goes' }, 'json means "any value": no type keyword')
  assertWireSchema(wire, 'json escape hatch')
})

test('wire: no boolean required survives anywhere in the serialized document', () => {
  for (const tool of daemonTools()) {
    const serialized = JSON.stringify(specToJsonSchema(toDshSpec(tool.inputSchema)))
    assert.ok(!/"required":(true|false)/.test(serialized), `${tool.name} leaks a boolean required marker`)
  }
})

test('wire: an unrepresentable property degrades alone instead of emitting an illegal schema', () => {
  // Hostile: a property whose author form cannot be mirrored must not
  // poison the whole document. It becomes an unconstrained node.
  const wire = specToJsonSchema({ good: { type: 'string' }, weird: { type: 'nonsense' } })
  assert.equal(wire.properties.good.type, 'string')
  assert.ok(!Object.hasOwn(wire.properties.weird, 'type'), 'illegal node must not carry a bad type')
  assertWireSchema(wire, 'degraded tool')
})

test('wire: an empty parameter map still projects to a valid object root', () => {
  // The status tool registers with no parameters; `{}` is not a schema.
  const wire = specToJsonSchema({})
  assert.deepEqual(wire, { type: 'object', properties: {} })
  assertWireSchema(wire, 'status tool')
})

test('wire: scalar enum/const survive the projection', () => {
  const wire = specToJsonSchema(toDshSpec({ type: 'object', properties: { kind: { type: 'string', enum: ['a', 'b'] }, lock: { type: 'string', const: 'x' } } }))
  assert.deepEqual(wire.properties.kind.enum, ['a', 'b'])
  assert.equal(wire.properties.lock.const, 'x')
  assertWireSchema(wire, 'enum tool')
})

/**
 * Shared test oracle for the contract `ctx.tools.register()` enforces.
 *
 * The registry does NOT compile `parameters` the way defineTool() does:
 * it stores the definition and ToolRuntime.schemaOf() copies
 * `parameters` onto the model request verbatim. So a definition handed
 * to register() must already carry a JSON Schema document inside the
 * harness's raw-schema subset. A bare property map (the author form) is
 * silently accepted by the registry and then rejected by every
 * OpenAI-compatible provider with HTTP 400 / DeepSeek 11129, which takes
 * the whole request down rather than just the offending tool.
 *
 * This mirrors @deepseek-ai/dsh-tools checkSchemaNode, restricted to the
 * keywords the enforced subset allows. Reading the real thing is better
 * still: test/real-registry.test.mjs asserts against the actual package.
 */
import assert from 'node:assert/strict'

export const WIRE_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** `required` and friends may not sit beside `oneOf`. */
const SIBLINGS_OF_ONEOF = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** Collect every way `node` violates the raw-schema subset. */
export function wireViolations(node, path = 'parameters', out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return out
  }
  for (const key of Object.keys(node)) {
    if (!WIRE_KEYWORDS.has(key)) out.push(`${path}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`)
    return out
  }
  if (!hasType && !hasOneOf) {
    // An annotation-only node (the projection of the author `json` node)
    // is legal: it constrains nothing. But object/array/oneOf members may
    // not appear without a declared type, which is what the harness checks.
    for (const key of SIBLINGS_OF_ONEOF) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} requires type or oneOf`)
    }
    return out
  }
  if (hasOneOf) {
    for (const key of SIBLINGS_OF_ONEOF) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} is not supported beside oneOf`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      out.push(`${path}.oneOf must be an array of at least two schemas`)
      return out
    }
    node.oneOf.forEach((branch, index) => wireViolations(branch, `${path}.oneOf[${index}]`, out))
    return out
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) {
    out.push(
      Array.isArray(node.type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${[...SCHEMA_TYPES].join('/')}`,
    )
    return out
  }
  // Each container keyword is only supported on its own type. This is the
  // rule that catches a stray boolean `required` left on a scalar node.
  const KEYWORD_TYPES = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      out.push(`${path}.${key} is not supported on type "${node.type}"`)
    }
  }
  if (node.type === 'object') {
    // additionalProperties and items are OPTIONAL in the raw subset; the
    // harness only type-checks them when they are present. Emitting them
    // explicitly is a deliberate choice by specToJsonSchema, not a
    // requirement, so this oracle must not demand them.
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      out.push(`${path}.additionalProperties must be a boolean`)
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        out.push(`${path}.required must be an array of strings`)
      } else {
        for (const key of node.required) {
          if (!Object.hasOwn(node.properties ?? {}, key)) {
            out.push(`${path}.required names "${key}" which is not in properties`)
          }
        }
      }
    }
    if (Object.hasOwn(node, 'properties')) {
      if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        out.push(`${path}.properties must be an object`)
      } else {
        for (const [name, child] of Object.entries(node.properties)) {
          wireViolations(child, `${path}.properties.${name}`, out)
        }
      }
    }
    return out
  }
  if (node.type === 'array') {
    if (Object.hasOwn(node, 'items')) wireViolations(node.items, `${path}.items`, out)
  }
  return out
}

/** The real assertion, when the package resolves (it is a devDependency). */
let assertSupportedJsonSchema = undefined
try {
  ;({ assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools'))
} catch {
  // The local mirror below still guards the shape.
}

/** Assert one registered definition carries a legal JSON Schema document. */
export function assertWireSchema(wire, label) {
  assert.equal(
    wire?.type,
    'object',
    `${label}: register() forwards parameters verbatim, so the root must be an object schema; got ${JSON.stringify(wire).slice(0, 160)}`,
  )
  assert.ok(
    wire.properties !== null && typeof wire.properties === 'object' && !Array.isArray(wire.properties),
    `${label}: an object schema needs a properties map`,
  )
  const violations = wireViolations(wire)
  assert.deepEqual(violations, [], `${label} is outside the harness JSON Schema subset`)
  // Belt and braces: run the authoritative assertion too. This is the exact
  // check that would have caught the 11129 wire bug.
  if (typeof assertSupportedJsonSchema === 'function') {
    try {
      assertSupportedJsonSchema(wire)
    } catch (err) {
      assert.fail(`${label} rejected by @deepseek-ai/dsh-tools: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

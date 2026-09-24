/**
 * Tool-name helpers and the dsh parameter-schema transforms.
 *
 * Two distinct layers are involved, and confusing them ships a broken
 * tool to the model:
 *
 * 1. AUTHOR form (implicit parameter schema), a property map of value
 *    schemas with per-property `required` flags:
 *
 *      { url: { type: 'string', required: true, description: '...' } }
 *
 *    This is what `defineTool({ parameters })` accepts; the harness
 *    compiles it with parameterSchemaSpecToJsonSchema() and validates
 *    calls with validateArgs(). Nothing else consumes it.
 *
 * 2. WIRE form (JSON Schema document), what ToolSchema.parameters must
 *    already be when a definition goes to `ctx.tools.register()`:
 *
 *      { type: 'object', properties: { ... }, required: ['url'] }
 *
 *    register() does NOT compile: it stores the definition and
 *    ToolRuntime.schemaOf() copies `parameters` straight onto the
 *    model request. The first-party MCP bridge likewise registers its
 *    raw JSON Schema. Receiving a bare property map here is silently
 *    accepted by the registry and then rejected by every
 *    OpenAI-compatible provider with HTTP 400 / DeepSeek 11129
 *    ("invalid function call parameters"), which takes the WHOLE
 *    request down, not just the offending tool.
 *
 * So: toDshSpec() sanitizes a hostile MCP inputSchema into the author
 * form (dropping keywords the harness subset cannot enforce), and
 * specToJsonSchema() projects that into the wire form for register().
 *
 * Value-schema dialect compiled by the harness:
 * - type: 'json' | 'object' | 'array' | 'string' | 'number' |
 *   'integer' | 'boolean' | 'null', or oneOf without type;
 * - object requires explicit `additionalProperties` boolean;
 * - array entries use `items`, object entries use `properties`;
 * - scalars may carry `enum`/`const`;
 * - `required` exists ONLY on property-map entries;
 * - annotations: description (+ title).
 * Anything else is dropped so register + validateArgs can never trip.
 */
export declare function sanitizeRawName(raw: unknown): string | null;
/** Final public (model-facing) tool name, or null when unsupported. */
export declare function publicToolName(prefix: string, raw: string): string | null;
export declare function isValidPrefix(prefix: unknown): boolean;
/**
 * Project an arbitrary MCP `inputSchema` document into the dsh
 * implicit parameter schema (the AUTHOR form; `specToJsonSchema()`
 * projects that onto the register() wire form). Always returns a
 * valid author-form map; unusable inputs degrade to open `json`
 * parameters.
 */
export declare function toDshSpec(rawSchema: unknown): Record<string, unknown>;
/**
 * Project the author form (see the module header) into the JSON Schema
 * document that `ctx.tools.register()` must receive.
 *
 * `required` moves from per-property booleans to the parent's array, at
 * every depth: a boolean left inside a subschema is not valid JSON
 * Schema and trips the same provider rejection. The author-only `json`
 * node becomes an annotation-only schema (any value), and object nodes
 * keep an explicit `additionalProperties`.
 */
export declare function specToJsonSchema(spec: Record<string, unknown>): Record<string, unknown>;
/**
 * Deterministic mirror of the harness's spec-authoring rules. Null on
 * success, a readable violation otherwise. Everything this module
 * emits must pass, so a violation here is always a bug in this file,
 * not in the environment.
 */
export declare function specViolation(spec: unknown): string | null;
/** Presentation kind mapping for the tool call cards. */
export declare function callKind(toolName: string): 'fetch' | 'search' | 'other';
/** Compact call title. */
export declare function callTitle(toolName: string, args: unknown): string;
/** First non-empty, non-markdown line of a text blob. */
export declare function firstLine(text: string, max: number): string;
export declare function truncate(text: string, max: number): string;

/**
 * Tool-name helpers and the dsh parameter-schema transform.
 *
 * Cotrast to JSON Schema documents: @deepseek-ai/dsh-tools consumes
 * `ToolDefinition.parameters` in its IMPLICIT PARAMETER SCHEMA form,
 * a property map of value schemas:
 *
 *   { url: { type: 'string', required: true, description: '...' } }
 *
 * no `type: 'object'`/`properties` wrapper, and `required` is a
 * per-property flag, not an array. The runtime compiles this into the
 * JSON Schema handed to the model (parameterSchemaSpecToJsonSchema)
 * and validates every call's arguments against it (validateArgs).
 * Registering a raw MCP `inputSchema` document in the schema-document
 * form poisons the map: the word `type` becomes a parameter name and
 * every call dies in argument validation. That is the failure mode
 * this transform removes.
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
 * implicit parameter schema. Always returns a register-safe map;
 * unusable inputs degrade to open `json` parameters.
 */
export declare function toDshSpec(rawSchema: unknown): Record<string, unknown>;
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

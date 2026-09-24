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
/** DeepSeek Harness tool name contract. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
export function sanitizeRawName(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s.length === 0 || s.length > 64)
        return null;
    if (!NAME_RE.test(s))
        return null;
    return s;
}
/** Final public (model-facing) tool name, or null when unsupported. */
export function publicToolName(prefix, raw) {
    const clean = sanitizeRawName(raw);
    if (clean === null)
        return null;
    const full = `${prefix}_${clean}`;
    if (full.length > 64)
        return null;
    return full;
}
export function isValidPrefix(prefix) {
    return typeof prefix === 'string' && prefix.length >= 1 && prefix.length <= 16 && NAME_RE.test(prefix);
}
const SPEC_TYPES = new Set([
    'json',
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
]);
const SCALAR_SPEC_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
function isPlainObject(v) {
    if (v === null || typeof v !== 'object')
        return false;
    if (Array.isArray(v))
        return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}
const DROPPED_KEYWORD_MESSAGE = {
    maxItems: 'maxItems',
    minItems: 'minItems',
    minLength: 'minLength',
    maxLength: 'maxLength',
    pattern: 'pattern',
    format: 'format',
};
/** Append host-side constraints the model should still respect. */
function droppedConstraintNote(node) {
    const notes = [];
    for (const keyword of Object.keys(DROPPED_KEYWORD_MESSAGE)) {
        if (Object.hasOwn(node, keyword)) {
            notes.push(`${keyword} ${JSON.stringify(node[keyword])}`);
        }
    }
    if (notes.length === 0)
        return null;
    return `server constraint: ${notes.join(', ')}`;
}
/**
 * Convert one JSON-Schema node into a dsh value schema. `required` is
 * emitted only when parent grants it (property-map entries).
 */
function valueSchema(node, required) {
    const raw = isPlainObject(node) ? node : null;
    const out = {};
    const note = raw !== null ? droppedConstraintNote(raw) : null;
    const description = typeof raw?.description === 'string' ? raw.description : undefined;
    if (description !== undefined) {
        out.description = note === null ? description : `${description} (${note})`;
    }
    else if (note !== null) {
        out.description = note;
    }
    if (typeof raw?.title === 'string')
        out.title = raw.title;
    if (required)
        out.required = true;
    const oneOf = raw !== null && Array.isArray(raw.anyOf) ? raw.anyOf : raw !== null && Array.isArray(raw.oneOf) ? raw.oneOf : null;
    if (oneOf !== null) {
        const branches = [];
        for (const branch of oneOf) {
            const converted = valueSchema(branch, false);
            if (Object.keys(converted).length > 0)
                branches.push(converted);
        }
        if (branches.length >= 2) {
            out.oneOf = branches;
            return out;
        }
    }
    let type;
    if (raw !== null && typeof raw.type === 'string' && SPEC_TYPES.has(raw.type))
        type = raw.type;
    if (type === undefined)
        type = 'json';
    switch (type) {
        case 'object': {
            out.type = 'object';
            const addl = !Object.hasOwn(raw ?? {}, 'additionalProperties') || raw.additionalProperties !== false;
            out.additionalProperties = addl;
            if (raw !== null && isPlainObject(raw.properties)) {
                const props = {};
                for (const [name, child] of Object.entries(raw.properties)) {
                    const childRequired = Array.isArray(raw.required) && raw.required.includes(name);
                    const converted = valueSchema(child, childRequired);
                    if (Object.keys(converted).length > 0)
                        props[name] = converted;
                }
                if (Object.keys(props).length > 0)
                    out.properties = props;
            }
            return out;
        }
        case 'array': {
            out.type = 'array';
            if (raw !== null && raw.items !== undefined) {
                const converted = valueSchema(raw.items, false);
                if (Object.keys(converted).length > 0)
                    out.items = converted;
                else
                    out.items = { type: 'json' };
            }
            return out;
        }
        default: {
            out.type = type;
            if (type !== 'json' && raw !== null) {
                if (Array.isArray(raw.enum)) {
                    const entries = raw.enum.filter((entry) => enumMatches(entry, type));
                    if (entries.length > 0)
                        out.enum = entries;
                }
                if (raw.const !== undefined && enumMatches(raw.const, type))
                    out.const = raw.const;
                if (out.enum !== undefined && out.const !== undefined)
                    delete out.enum;
            }
            return out;
        }
    }
}
function enumMatches(entry, type) {
    if (type === 'null')
        return entry === null;
    if (entry === null)
        return false;
    if (type === 'integer')
        return typeof entry === 'number' && Number.isInteger(entry);
    if (type === 'number')
        return typeof entry === 'number' && Number.isFinite(entry);
    return typeof entry === type;
}
/**
 * Project an arbitrary MCP `inputSchema` document into the dsh
 * implicit parameter schema (the AUTHOR form; `specToJsonSchema()`
 * projects that onto the register() wire form). Always returns a
 * valid author-form map; unusable inputs degrade to open `json`
 * parameters.
 */
export function toDshSpec(rawSchema) {
    const raw = isPlainObject(rawSchema) ? rawSchema : {};
    const result = {};
    if (isPlainObject(raw.properties)) {
        for (const [name, child] of Object.entries(raw.properties)) {
            const required = Array.isArray(raw.required) && raw.required.includes(name);
            const converted = valueSchema(child, required);
            if (Object.keys(converted).length === 0) {
                converted.type = 'json';
                if (required)
                    converted.required = true;
            }
            result[name] = converted;
        }
    }
    if (Object.keys(result).length === 0) {
        return { input: { type: 'json' } };
    }
    return result;
}
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
export function specToJsonSchema(spec) {
    return propertyMapToJsonSchema(spec, 'parameters');
}
function propertyMapToJsonSchema(spec, path) {
    const properties = {};
    const required = [];
    for (const [name, value] of Object.entries(isPlainObject(spec) ? spec : {})) {
        const violation = valueSchemaViolation(value, `${path}.${name}`, true);
        if (violation !== null) {
            // Never emit a schema the harness subset forbids: degrade this one
            // property to an unconstrained value so the tool stays callable.
            properties[name] = { description: `unrepresentable parameter (${violation})` };
            continue;
        }
        const { required: isRequired, ...node } = value;
        properties[name] = nodeToJsonSchema(node, `${path}.${name}`);
        if (isRequired === true)
            required.push(name);
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}
/** Convert one author-form value schema node into a JSON Schema node. */
function nodeToJsonSchema(node, path) {
    const raw = isPlainObject(node) ? node : {};
    const out = {};
    if (typeof raw.description === 'string')
        out.description = raw.description;
    if (typeof raw.title === 'string')
        out.title = raw.title;
    if (Array.isArray(raw.oneOf)) {
        out.oneOf = raw.oneOf.map((branch, index) => nodeToJsonSchema(branch, `${path}.oneOf[${index}]`));
        return out;
    }
    const type = typeof raw.type === 'string' ? raw.type : 'json';
    switch (type) {
        case 'object': {
            out.type = 'object';
            out.additionalProperties = raw.additionalProperties === true;
            const nested = propertyMapToJsonSchema(raw.properties, `${path}.properties`);
            out.properties = nested.properties;
            if (Array.isArray(nested.required))
                out.required = nested.required;
            return out;
        }
        case 'array': {
            out.type = 'array';
            out.items = raw.items === undefined ? {} : nodeToJsonSchema(raw.items, `${path}.items`);
            return out;
        }
        default: {
            // `json` is author-only: an unconstrained value is an annotation-only node.
            if (type === 'json')
                return out;
            out.type = type;
            if (Array.isArray(raw.enum))
                out.enum = raw.enum;
            if (raw.const !== undefined)
                out.const = raw.const;
            return out;
        }
    }
}
/**
 * Deterministic mirror of the harness's spec-authoring rules. Null on
 * success, a readable violation otherwise. Everything this module
 * emits must pass, so a violation here is always a bug in this file,
 * not in the environment.
 */
export function specViolation(spec) {
    return propertyMapViolation(spec, 'parameters');
}
function propertyMapViolation(input, path) {
    if (!isPlainObject(input))
        return `${path} must be an object of value schemas`;
    for (const [name, right] of Object.entries(input)) {
        if (!isPlainObject(right))
            return `${path}.${name} must be a value schema object`;
        const violation = valueSchemaViolation(right, `${path}.${name}`, true);
        if (violation !== null)
            return violation;
    }
    return null;
}
function valueSchemaViolation(input, path, allowRequired) {
    if (!isPlainObject(input))
        return `${path} must be a value schema object`;
    const authorKeys = ['type', 'description', 'title', 'enum', 'const', 'oneOf', 'properties', 'additionalProperties', 'items'];
    if (allowRequired)
        authorKeys.push('required');
    for (const key of Object.keys(input)) {
        if (!authorKeys.includes(key))
            return `${path}: unsupported keyword ${JSON.stringify(key)}`;
    }
    if (Object.hasOwn(input, 'description') && typeof input.description !== 'string')
        return `${path}.description must be a string`;
    if (Object.hasOwn(input, 'title') && typeof input.title !== 'string')
        return `${path}.title must be a string`;
    if (Object.hasOwn(input, 'required') && (!allowRequired || typeof input.required !== 'boolean')) {
        return `${path}.required is only a property-map boolean flag`;
    }
    const hasOneOf = Object.hasOwn(input, 'oneOf');
    const hasType = Object.hasOwn(input, 'type');
    if (hasOneOf && hasType)
        return `${path} cannot declare both type and oneOf`;
    if (hasOneOf) {
        const allowed = allowRequired ? ['oneOf', 'description', 'title', ...(allowRequired ? ['required'] : [])] : ['oneOf', 'description', 'title'];
        for (const key of Object.keys(input)) {
            if (!allowed.includes(key))
                return `${path}: ${JSON.stringify(key)} cannot accompany oneOf`;
        }
        if (!Array.isArray(input.oneOf) || input.oneOf.length < 2)
            return `${path}.oneOf must be an array of at least two value schemas`;
        for (let index = 0; index < input.oneOf.length; index++) {
            const violation = valueSchemaViolation(input.oneOf[index], `${path}.oneOf[${index}]`, false);
            if (violation !== null)
                return violation;
        }
        return null;
    }
    if (!hasType)
        return `${path} must declare a type or oneOf`;
    const type = input.type;
    if (typeof type !== 'string' || !SPEC_TYPES.has(type))
        return `${path}.type must be one of ${[...SPEC_TYPES].join('/')}`;
    if (type === 'json') {
        const extras = Object.keys(input).filter((k) => !['type', 'description', 'title'].includes(k) && !(allowRequired && k === 'required'));
        if (extras.length > 0)
            return `${path}: ${JSON.stringify(extras[0])} cannot accompany type json`;
        return null;
    }
    if (type === 'object') {
        if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
            return `${path}.additionalProperties must be explicitly true or false`;
        }
        if (Object.hasOwn(input, 'properties')) {
            if (!isPlainObject(input.properties))
                return `${path}.properties must be an object`;
            for (const [name, right] of Object.entries(input.properties)) {
                const violation = valueSchemaViolation(right, `${path}.properties.${name}`, true);
                if (violation !== null)
                    return violation;
            }
        }
        return null;
    }
    if (type === 'array') {
        if (!Object.hasOwn(input, 'items') || !isPlainObject(input.items))
            return `${path}.items must be a value schema`;
        const violation = valueSchemaViolation(input.items, `${path}.items`, false);
        if (violation !== null)
            return violation;
        return null;
    }
    const extras = Object.keys(input).filter((k) => !['type', 'description', 'title', 'enum', 'const'].includes(k) && !(allowRequired && k === 'required'));
    if (extras.length > 0)
        return `${path}: ${JSON.stringify(extras[0])} cannot accompany type ${type}`;
    if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0)
            return `${path}.enum must be a non-empty array`;
        for (const entry of input.enum) {
            if (!enumMatches(entry, type))
                return `${path}.enum value ${JSON.stringify(entry)} does not match type ${type}`;
        }
    }
    if (Object.hasOwn(input, 'const') && !enumMatches(input.const, type)) {
        return `${path}.const does not match type ${type}`;
    }
    return null;
}
/** Presentation kind mapping for the tool call cards. */
export function callKind(toolName) {
    if (toolName.includes('search'))
        return 'search';
    if (toolName.includes('fetch') || toolName.includes('crawl'))
        return 'fetch';
    return 'other';
}
/** Compact call title. */
export function callTitle(toolName, args) {
    if (args !== null && typeof args === 'object') {
        const a = args;
        if (typeof a.query === 'string' && a.query.length > 0)
            return `${toolName} \u00B7 "${truncate(a.query, 56)}"`;
        if (typeof a.url === 'string' && a.url.length > 0) {
            try {
                const url = new URL(a.url);
                return `${toolName} \u00B7 ${url.hostname}${url.pathname === '/' ? '' : truncate(url.pathname, 28)}`;
            }
            catch {
                return `${toolName} \u00B7 ${truncate(a.url, 56)}`;
            }
        }
    }
    return toolName;
}
/** First non-empty, non-markdown line of a text blob. */
export function firstLine(text, max) {
    for (const raw of text.split('\n')) {
        const line = raw
            .replace(/^\s*(#{1,4}|\*\*|###)\s*/g, '')
            .trim();
        if (line.length > 0)
            return truncate(line, max);
    }
    return '';
}
export function truncate(text, max) {
    if (text.length <= max)
        return text;
    const cut = text.slice(0, max - 1).replace(/\s+\S*$/, '');
    return cut + '\u2026';
}
